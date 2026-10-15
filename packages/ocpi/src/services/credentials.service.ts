// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import {
  db,
  ocpiPartners,
  ocpiPartnerEndpoints,
  ocpiCredentialsTokens,
  ocpiPartnerAuditLog,
  writeAudit,
} from '@evtivity/database';
import { eq, and, ne } from 'drizzle-orm';
import { createLogger, encryptString, decryptString } from '@evtivity/lib';
import { OcpiClient } from '../lib/ocpi-client.js';
import { OcpiStatusCode } from '../lib/ocpi-response.js';
import { config } from '../lib/config.js';
import type {
  OcpiBusinessDetails,
  OcpiCredentials,
  OcpiVersionDetail,
  OcpiVersionInfo,
  OcpiVersion,
} from '../types/ocpi.js';

const logger = createLogger('ocpi-credentials');

function getEncryptionKey(): string {
  return config.SETTINGS_ENCRYPTION_KEY;
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function getBaseUrl(): string {
  return config.OCPI_BASE_URL;
}

function getOurCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getOurPartyId(): string {
  return config.OCPI_PARTY_ID;
}

function getOurBusinessName(): string {
  return config.OCPI_BUSINESS_NAME;
}

/**
 * The audit view of a partner: what the handshake changes, never a token
 * (the credentials token, the registration token or their ciphertext).
 */
interface PartnerAuditView {
  name?: string;
  status?: string;
  version?: string | null;
  versionUrl?: string | null;
  roles?: unknown;
  endpointCount?: number;
}

/**
 * The `ocpi_partner` audit row of a handshake the partner (or the OCPI
 * server for an operator's outbound registration) carried out: actor
 * `system`, label `ocpi-credentials`. Fail-open (writeAudit).
 */
async function auditPartnerHandshake(
  partnerId: string,
  action: 'registered' | 'updated' | 'disconnected',
  before: PartnerAuditView | null,
  after: PartnerAuditView,
  notes: string,
  database: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  await writeAudit(
    { table: ocpiPartnerAuditLog, idColumn: 'ocpi_partner_id' },
    {
      entityId: partnerId,
      entityIdSnapshot: partnerId,
      action,
      actor: 'system',
      actorLabel: 'ocpi-credentials',
      before,
      after,
      notes,
    },
    database,
    logger,
  );
}

export function buildOurCredentials(token: string): OcpiCredentials {
  const businessDetails: OcpiBusinessDetails = { name: getOurBusinessName() };
  const website = config.OCPI_WEBSITE;
  if (website != null) {
    businessDetails.website = website;
  }

  return {
    token,
    url: `${getBaseUrl()}/ocpi/versions`,
    roles: [
      {
        role: 'CPO',
        business_details: businessDetails,
        party_id: getOurPartyId(),
        country_code: getOurCountryCode(),
      },
      {
        role: 'EMSP',
        business_details: businessDetails,
        party_id: getOurPartyId(),
        country_code: getOurCountryCode(),
      },
    ],
  };
}

type ServiceDb = Pick<typeof db, 'insert' | 'update' | 'delete' | 'select'>;

/** A refused handshake: the HTTP status, the OCPI status and a fixed message. */
export class CredentialsError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly ocpiStatus: OcpiStatusCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialsError';
  }
}

/**
 * The partner's outbound requests failed during the handshake. Logged with
 * the cause; the partner gets a fixed message (OCPI 3001), never the cause.
 */
function unableToUseClientApi(err: unknown): never {
  if (err instanceof CredentialsError) throw err;
  logger.warn({ err }, 'OCPI handshake: request to the partner failed');
  throw new CredentialsError(
    400,
    OcpiStatusCode.SERVER_UNABLE_TO_USE_API,
    "Unable to use the client's API",
  );
}

/** A credentials token we issue to a partner (it calls us with it). */
export async function generateAndStoreToken(
  partnerId: string,
  direction: 'issued' | 'received',
  database: ServiceDb = db,
): Promise<string> {
  const token = generateToken();
  const tokenHash = await argon2.hash(token);
  const tokenPrefix = token.slice(0, 8);

  await database.insert(ocpiCredentialsTokens).values({
    partnerId,
    tokenHash,
    tokenPrefix,
    direction,
    kind: 'credentials',
    isActive: true,
  });

  return token;
}

async function deactivateTokens(
  partnerId: string,
  direction: 'issued' | 'received',
  database: ServiceDb = db,
): Promise<void> {
  await database
    .update(ocpiCredentialsTokens)
    .set({ isActive: false })
    .where(
      and(
        eq(ocpiCredentialsTokens.partnerId, partnerId),
        eq(ocpiCredentialsTokens.direction, direction),
        eq(ocpiCredentialsTokens.isActive, true),
      ),
    );
}

/** Stores the token the partner gave us for our calls to it. */
async function storeReceivedToken(
  partnerId: string,
  token: string,
  database: ServiceDb,
): Promise<void> {
  await deactivateTokens(partnerId, 'received', database);
  const encKey = getEncryptionKey();
  await database.insert(ocpiCredentialsTokens).values({
    partnerId,
    tokenHash: await argon2.hash(token),
    tokenPrefix: token.slice(0, 8),
    direction: 'received',
    kind: 'credentials',
    isActive: true,
    outboundTokenEnc: encKey !== '' ? encryptString(token, encKey) : null,
  });
}

async function replaceEndpoints(
  partnerId: string,
  endpoints: OcpiVersionDetail['endpoints'],
  database: ServiceDb,
): Promise<void> {
  await database.delete(ocpiPartnerEndpoints).where(eq(ocpiPartnerEndpoints.partnerId, partnerId));
  if (endpoints.length > 0) {
    await database.insert(ocpiPartnerEndpoints).values(
      endpoints.map((ep) => ({
        partnerId,
        module: ep.identifier,
        interfaceRole: ep.role,
        url: ep.url,
      })),
    );
  }
}

/**
 * Every role of the credentials must name the partner the token is bound to:
 * a registration token issued for NL/ABC cannot register (or claim roles
 * for) another party.
 */
function assertRolesMatchPartner(
  credentials: OcpiCredentials,
  partner: { countryCode: string; partyId: string },
): void {
  const mismatch = credentials.roles.some(
    (r) => r.country_code !== partner.countryCode || r.party_id !== partner.partyId,
  );
  if (mismatch) {
    throw new CredentialsError(
      400,
      OcpiStatusCode.CLIENT_INVALID_PARAMS,
      'The credentials roles do not match the registered party',
    );
  }
}

async function fetchPartnerEndpoints(
  versionsUrl: string,
  token: string,
  preferredVersion: OcpiVersion,
  allowPrivateNetwork: boolean,
  rawToken: boolean,
): Promise<{ version: OcpiVersion; endpoints: OcpiVersionDetail['endpoints'] }> {
  const client = new OcpiClient({
    token,
    fromCountryCode: getOurCountryCode(),
    fromPartyId: getOurPartyId(),
    toCountryCode: '',
    toPartyId: '',
    allowPrivateNetwork,
    rawToken,
  });

  const versionsResponse = await client.get<OcpiVersionInfo[]>(versionsUrl);
  const versions = versionsResponse.data;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error('Partner returned no versions');
  }

  // Prefer the requested version, fall back to any supported version
  const supportedVersions = ['2.3.0', '2.2.1'] as const;
  let selectedVersion: OcpiVersionInfo | undefined;

  const preferred = versions.find((v) => v.version === preferredVersion);
  if (preferred != null) {
    selectedVersion = preferred;
  } else {
    for (const sv of supportedVersions) {
      const found = versions.find((v) => v.version === sv);
      if (found != null) {
        selectedVersion = found;
        break;
      }
    }
  }

  if (selectedVersion == null) {
    throw new Error('No compatible OCPI version found');
  }

  const detailResponse = await client.get<OcpiVersionDetail>(selectedVersion.url);
  const detail = detailResponse.data as OcpiVersionDetail | null;
  if (detail == null || !Array.isArray(detail.endpoints)) {
    throw new Error('Partner returned invalid version detail');
  }

  return {
    version: selectedVersion.version,
    endpoints: detail.endpoints,
  };
}

interface AuthenticatedToken {
  tokenId: number;
  partnerId: string;
}

/**
 * POST credentials (OCPI 2.3.0 7.2.2) with a registration token. The token
 * is bound to the partner the operator created; every role must carry that
 * partner's country code and party id. The partner's versions and endpoints
 * are read first (outside any transaction); the token claim, the partner,
 * its endpoints and tokens, and the audit row then commit together, so a
 * failed registration leaves the registration token usable.
 */
export async function handleRegistration(
  credentials: OcpiCredentials,
  auth: AuthenticatedToken,
  preferredVersion: OcpiVersion = '2.2.1',
): Promise<OcpiCredentials> {
  logger.info({ partnerId: auth.partnerId, url: credentials.url }, 'Processing registration');

  const [partner] = await db
    .select()
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, auth.partnerId))
    .limit(1);
  if (partner == null) {
    throw new CredentialsError(401, OcpiStatusCode.CLIENT_ERROR, 'Invalid token');
  }
  if (partner.status === 'connected') {
    throw new CredentialsError(
      405,
      OcpiStatusCode.CLIENT_ERROR,
      'Already registered. Use PUT to update credentials.',
    );
  }
  assertRolesMatchPartner(credentials, partner);

  let fetched: { version: OcpiVersion; endpoints: OcpiVersionDetail['endpoints'] };
  try {
    fetched = await fetchPartnerEndpoints(
      credentials.url,
      credentials.token,
      preferredVersion,
      partner.allowPrivateNetwork,
      partner.allowRawToken,
    );
  } catch (err) {
    unableToUseClientApi(err);
  }
  const { version, endpoints } = fetched;
  const name = credentials.roles[0]?.business_details.name ?? partner.name;

  const newToken = await db.transaction(async (tx) => {
    // The claim: one of two concurrent registrations with the same token wins.
    const claimed = await tx
      .update(ocpiCredentialsTokens)
      .set({ isActive: false })
      .where(
        and(
          eq(ocpiCredentialsTokens.id, auth.tokenId),
          eq(ocpiCredentialsTokens.partnerId, auth.partnerId),
          eq(ocpiCredentialsTokens.kind, 'registration'),
          eq(ocpiCredentialsTokens.isActive, true),
        ),
      )
      .returning({ id: ocpiCredentialsTokens.id });
    if (claimed.length === 0) {
      throw new CredentialsError(401, OcpiStatusCode.CLIENT_ERROR, 'Invalid token');
    }

    const [locked] = await tx
      .select({ status: ocpiPartners.status })
      .from(ocpiPartners)
      .where(eq(ocpiPartners.id, auth.partnerId))
      .for('update');
    if (locked == null || locked.status === 'connected') {
      throw new CredentialsError(
        405,
        OcpiStatusCode.CLIENT_ERROR,
        'Already registered. Use PUT to update credentials.',
      );
    }

    await tx
      .update(ocpiPartners)
      .set({
        name,
        roles: credentials.roles,
        ourRoles: buildOurCredentials('').roles,
        status: 'connected',
        version,
        versionUrl: credentials.url,
        // The handshake is done: an operator-stored outbound token C retires.
        partnerRegistrationTokenEnc: null,
        updatedAt: new Date(),
      })
      .where(eq(ocpiPartners.id, auth.partnerId));

    await replaceEndpoints(auth.partnerId, endpoints, tx);
    await storeReceivedToken(auth.partnerId, credentials.token, tx);
    // Every other issued token (another open registration token included)
    // retires; the new credentials token is the only one left.
    await deactivateTokens(auth.partnerId, 'issued', tx);
    const issued = await generateAndStoreToken(auth.partnerId, 'issued', tx);

    await auditPartnerHandshake(
      auth.partnerId,
      'registered',
      {
        name: partner.name,
        status: partner.status,
        version: partner.version,
        versionUrl: partner.versionUrl,
      },
      {
        name,
        status: 'connected',
        version,
        versionUrl: credentials.url,
        roles: credentials.roles,
        endpointCount: endpoints.length,
      },
      'Partner registered through POST credentials',
      tx,
    );
    return issued;
  });

  return buildOurCredentials(newToken);
}

/**
 * PUT credentials (OCPI 2.3.0 7.2.3) with a credentials token. A partner
 * still pending (our outbound registration sent it this token, and it
 * answers with PUT) completes the handshake here: connected, its open
 * registration tokens and stored token C retired. A suspended partner may
 * rotate its tokens but stays suspended.
 */
export async function handleCredentialUpdate(
  credentials: OcpiCredentials,
  partnerId: string,
  preferredVersion: OcpiVersion = '2.2.1',
): Promise<OcpiCredentials> {
  logger.info({ partnerId }, 'Updating credentials');

  const [current] = await db
    .select()
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, partnerId))
    .limit(1);
  if (current == null) {
    throw new CredentialsError(405, OcpiStatusCode.CLIENT_ERROR, 'Not registered');
  }
  assertRolesMatchPartner(credentials, current);

  let fetched: { version: OcpiVersion; endpoints: OcpiVersionDetail['endpoints'] };
  try {
    fetched = await fetchPartnerEndpoints(
      credentials.url,
      credentials.token,
      preferredVersion,
      current.allowPrivateNetwork,
      current.allowRawToken,
    );
  } catch (err) {
    unableToUseClientApi(err);
  }
  const { version, endpoints } = fetched;
  const name = credentials.roles[0]?.business_details.name ?? current.name;
  const completes = current.status === 'pending';

  const newToken = await db.transaction(async (tx) => {
    await tx
      .update(ocpiPartners)
      .set({
        name,
        roles: credentials.roles,
        version,
        versionUrl: credentials.url,
        ...(completes ? { status: 'connected' as const, partnerRegistrationTokenEnc: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(ocpiPartners.id, partnerId));

    await replaceEndpoints(partnerId, endpoints, tx);
    await storeReceivedToken(partnerId, credentials.token, tx);
    await deactivateTokens(partnerId, 'issued', tx);
    const issued = await generateAndStoreToken(partnerId, 'issued', tx);

    await auditPartnerHandshake(
      partnerId,
      completes ? 'registered' : 'updated',
      {
        name: current.name,
        status: current.status,
        version: current.version,
        versionUrl: current.versionUrl,
      },
      {
        name,
        status: completes ? 'connected' : current.status,
        version,
        versionUrl: credentials.url,
        roles: credentials.roles,
        endpointCount: endpoints.length,
      },
      completes
        ? 'Partner completed the registration through PUT credentials'
        : 'Partner updated its credentials through PUT credentials (tokens rotated)',
      tx,
    );
    return issued;
  });

  return buildOurCredentials(newToken);
}

export async function handleUnregister(partnerId: string): Promise<void> {
  logger.info({ partnerId }, 'Unregistering partner');

  await db.transaction(async (tx) => {
    await tx
      .update(ocpiPartners)
      .set({ status: 'disconnected', updatedAt: new Date() })
      .where(eq(ocpiPartners.id, partnerId));

    await tx
      .update(ocpiCredentialsTokens)
      .set({ isActive: false })
      .where(
        and(
          eq(ocpiCredentialsTokens.partnerId, partnerId),
          eq(ocpiCredentialsTokens.isActive, true),
        ),
      );

    await auditPartnerHandshake(
      partnerId,
      'disconnected',
      null,
      { status: 'disconnected' },
      'Partner unregistered through DELETE credentials',
      tx,
    );
  });
}

/**
 * Initiate outbound OCPI registration where WE are the Sender. The partner
 * has shared their one-time registration token (Token C) with us via OOB
 * channels; we stored it encrypted on `ocpi_partners.partner_registration_
 * token_enc`. This function decrypts it, calls the partner's /versions to
 * discover their /credentials endpoint, POSTs our credentials there, and
 * stores the Token B they hand back for ongoing outbound calls.
 *
 * Per the OCPI 2.2.1 registration flow Section 5.1.2:
 *   1. Sender (us) calls GET /versions on Receiver (partner) with Token C
 *   2. Sender calls GET on selected versionDetail URL with Token C
 *   3. Sender POSTs /credentials with body containing OUR new Token A
 *      (Receiver will use it to call us going forward) - using Token C
 *   4. Receiver responds with credentials containing THEIR new Token B
 *      (Sender uses it to call Receiver going forward)
 *   5. Token C is now retired on both sides
 */
export async function initiateRegistration(
  partnerId: string,
  preferredVersion: OcpiVersion = '2.2.1',
): Promise<OcpiCredentials> {
  logger.info({ partnerId }, 'Initiating outbound registration');

  const [partner] = await db
    .select()
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, partnerId))
    .limit(1);

  if (partner == null) {
    throw new Error('Partner not found');
  }

  // A connected partner updates its credentials with PUT, not a new POST.
  if (partner.status === 'connected') {
    throw new Error('Partner already connected');
  }

  if (partner.versionUrl == null || partner.versionUrl === '') {
    throw new Error('Partner versionUrl not configured');
  }

  if (partner.partnerRegistrationTokenEnc == null) {
    throw new Error(
      "Partner registration token not configured. Outbound registration requires the partner's OOB-shared Token C; set it via PATCH /v1/ocpi/partners/:id with partnerRegistrationToken.",
    );
  }

  const encKey = getEncryptionKey();
  if (encKey === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY not configured; cannot decrypt registration token');
  }

  const tokenC = decryptString(partner.partnerRegistrationTokenEnc, encKey);

  // Step 1+2: discover partner's endpoints using Token C
  const { version, endpoints } = await fetchPartnerEndpoints(
    partner.versionUrl,
    tokenC,
    preferredVersion,
    partner.allowPrivateNetwork,
    partner.allowRawToken,
  );

  const credentialsEndpoint = endpoints.find((ep) => ep.identifier === 'credentials');
  if (credentialsEndpoint == null) {
    throw new Error('Partner does not expose a credentials endpoint');
  }

  // Token A: the token the partner calls us with from now on. It is active
  // before the POST (the partner reads our versions with it while it
  // answers), the earlier issued tokens stay active until the partner
  // accepted, and a failed POST retires only this new token.
  const tokenA = generateToken();
  const [tokenARow] = await db
    .insert(ocpiCredentialsTokens)
    .values({
      partnerId,
      tokenHash: await argon2.hash(tokenA),
      tokenPrefix: tokenA.slice(0, 8),
      direction: 'issued',
      kind: 'credentials',
      isActive: true,
    })
    .returning({ id: ocpiCredentialsTokens.id });
  if (tokenARow == null) throw new Error('Failed to store the credentials token');
  const ourCredentials = buildOurCredentials(tokenA);

  const retireTokenA = async (): Promise<void> => {
    await db
      .update(ocpiCredentialsTokens)
      .set({ isActive: false })
      .where(eq(ocpiCredentialsTokens.id, tokenARow.id));
  };

  let theirCredentials: OcpiCredentials;
  let newEndpoints: OcpiVersionDetail['endpoints'];
  try {
    // Step 3: POST our credentials using Token C as bearer
    const client = new OcpiClient({
      token: tokenC,
      fromCountryCode: getOurCountryCode(),
      fromPartyId: getOurPartyId(),
      toCountryCode: partner.countryCode,
      toPartyId: partner.partyId,
      allowPrivateNetwork: partner.allowPrivateNetwork,
      rawToken: partner.allowRawToken,
    });

    const response = await client.post<OcpiCredentials>(credentialsEndpoint.url, ourCredentials);
    const received = response.data as OcpiCredentials | null;
    if (received == null || typeof received.token !== 'string' || received.token === '') {
      throw new Error('Partner returned no credentials');
    }
    theirCredentials = received;

    // The partner may return a new versions URL or endpoint list.
    ({ endpoints: newEndpoints } = await fetchPartnerEndpoints(
      theirCredentials.url,
      theirCredentials.token,
      version,
      partner.allowPrivateNetwork,
      partner.allowRawToken,
    ));
  } catch (err) {
    await retireTokenA();
    throw err;
  }

  await db.transaction(async (tx) => {
    // Step 4: store Token B (their token for our outbound calls) and retire
    // every issued token but Token A.
    await storeReceivedToken(partnerId, theirCredentials.token, tx);
    await tx
      .update(ocpiCredentialsTokens)
      .set({ isActive: false })
      .where(
        and(
          eq(ocpiCredentialsTokens.partnerId, partnerId),
          eq(ocpiCredentialsTokens.direction, 'issued'),
          eq(ocpiCredentialsTokens.isActive, true),
          ne(ocpiCredentialsTokens.id, tokenARow.id),
        ),
      );
    await replaceEndpoints(partnerId, newEndpoints, tx);

    // Step 5: Token C is now retired; clear the stored ciphertext.
    await tx
      .update(ocpiPartners)
      .set({
        status: 'connected',
        version,
        versionUrl: theirCredentials.url,
        partnerRegistrationTokenEnc: null,
        updatedAt: new Date(),
      })
      .where(eq(ocpiPartners.id, partnerId));

    await auditPartnerHandshake(
      partnerId,
      'registered',
      { status: partner.status, version: partner.version, versionUrl: partner.versionUrl },
      {
        status: 'connected',
        version,
        versionUrl: theirCredentials.url,
        endpointCount: newEndpoints.length,
      },
      'Outbound registration completed (registration token retired)',
      tx,
    );
  });

  return theirCredentials;
}
