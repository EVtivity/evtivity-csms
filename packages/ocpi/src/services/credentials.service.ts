// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { db, ocpiPartners, ocpiPartnerEndpoints, ocpiCredentialsTokens } from '@evtivity/database';
import { eq, and } from 'drizzle-orm';
import { createLogger, encryptString, decryptString } from '@evtivity/lib';
import { OcpiClient } from '../lib/ocpi-client.js';
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

export async function generateAndStoreToken(
  partnerId: string | null,
  direction: 'issued' | 'received',
): Promise<string> {
  const token = generateToken();
  const tokenHash = await argon2.hash(token);
  const tokenPrefix = token.slice(0, 8);

  await db.insert(ocpiCredentialsTokens).values({
    partnerId,
    tokenHash,
    tokenPrefix,
    direction,
    isActive: true,
  });

  return token;
}

async function deactivateTokens(
  partnerId: string,
  direction: 'issued' | 'received',
): Promise<void> {
  await db
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

/**
 * Atomically claim a registration token: flip isActive=false and return
 * whether THIS call won the race. Two concurrent registrations using the
 * same one-time token both pass the read-only middleware check; without an
 * atomic claim they would each create a partner row and issue duplicate
 * outbound tokens. Postgres serializes the conditional UPDATE so only one
 * caller sees a returning row.
 */
async function claimRegistrationToken(tokenId: number): Promise<boolean> {
  const claimed = await db
    .update(ocpiCredentialsTokens)
    .set({ isActive: false })
    .where(and(eq(ocpiCredentialsTokens.id, tokenId), eq(ocpiCredentialsTokens.isActive, true)))
    .returning({ id: ocpiCredentialsTokens.id });
  return claimed.length > 0;
}

async function fetchPartnerEndpoints(
  versionsUrl: string,
  token: string,
  preferredVersion: OcpiVersion,
  allowPrivateNetwork: boolean,
): Promise<{ version: OcpiVersion; endpoints: OcpiVersionDetail['endpoints'] }> {
  const client = new OcpiClient({
    token,
    fromCountryCode: getOurCountryCode(),
    fromPartyId: getOurPartyId(),
    toCountryCode: '',
    toPartyId: '',
    allowPrivateNetwork,
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

export async function handleRegistration(
  credentials: OcpiCredentials,
  registrationTokenId: number,
  preferredVersion: OcpiVersion = '2.2.1',
): Promise<OcpiCredentials> {
  logger.info({ url: credentials.url, roles: credentials.roles }, 'Processing registration');

  const partnerRole = credentials.roles[0];
  if (partnerRole == null) {
    throw new Error('No roles provided in credentials');
  }

  // Claim the registration token up front so a concurrent duplicate
  // submission cannot also create a partner / issue tokens. The middleware
  // only validates the token; without this guard two parallel POSTs both
  // pass and both run the full registration flow.
  const claimed = await claimRegistrationToken(registrationTokenId);
  if (!claimed) {
    const err = new Error('Registration token already used');
    (err as Error & { code: string }).code = 'TOKEN_ALREADY_USED';
    throw err;
  }

  // The partner may be pre-created by the operator (or the seed), with the
  // private-network flag that decides which addresses its URLs may reach.
  const existing = await db
    .select()
    .from(ocpiPartners)
    .where(
      and(
        eq(ocpiPartners.countryCode, partnerRole.country_code),
        eq(ocpiPartners.partyId, partnerRole.party_id),
      ),
    )
    .limit(1);

  // Fetch partner version and endpoints
  const { version, endpoints } = await fetchPartnerEndpoints(
    credentials.url,
    credentials.token,
    preferredVersion,
    existing[0]?.allowPrivateNetwork ?? false,
  );

  // Create or update partner

  let partnerId: string;

  if (existing.length > 0 && existing[0] != null) {
    partnerId = existing[0].id;
    await db
      .update(ocpiPartners)
      .set({
        name: partnerRole.business_details.name,
        roles: credentials.roles,
        ourRoles: buildOurCredentials('').roles,
        status: 'connected',
        version,
        versionUrl: credentials.url,
        updatedAt: new Date(),
      })
      .where(eq(ocpiPartners.id, partnerId));
  } else {
    const [inserted] = await db
      .insert(ocpiPartners)
      .values({
        name: partnerRole.business_details.name,
        countryCode: partnerRole.country_code,
        partyId: partnerRole.party_id,
        roles: credentials.roles,
        ourRoles: buildOurCredentials('').roles,
        status: 'connected',
        version,
        versionUrl: credentials.url,
      })
      .returning({ id: ocpiPartners.id });

    if (inserted == null) {
      throw new Error('Failed to create partner record');
    }
    partnerId = inserted.id;
  }

  // Store partner endpoints
  await db.delete(ocpiPartnerEndpoints).where(eq(ocpiPartnerEndpoints.partnerId, partnerId));

  if (endpoints.length > 0) {
    await db.insert(ocpiPartnerEndpoints).values(
      endpoints.map((ep) => ({
        partnerId,
        module: ep.identifier,
        interfaceRole: ep.role,
        url: ep.url,
      })),
    );
  }

  // Store the token they gave us (for calling them)
  await deactivateTokens(partnerId, 'received');
  const receivedTokenHash = await argon2.hash(credentials.token);
  const encKey = getEncryptionKey();
  const outboundTokenEnc = encKey !== '' ? encryptString(credentials.token, encKey) : null;
  await db.insert(ocpiCredentialsTokens).values({
    partnerId,
    tokenHash: receivedTokenHash,
    tokenPrefix: credentials.token.slice(0, 8),
    direction: 'received',
    isActive: true,
    outboundTokenEnc,
  });

  // Generate a new token for them to call us
  await deactivateTokens(partnerId, 'issued');
  const newToken = await generateAndStoreToken(partnerId, 'issued');

  // Registration token already deactivated atomically at the top of this
  // function via claimRegistrationToken().

  return buildOurCredentials(newToken);
}

export async function handleCredentialUpdate(
  credentials: OcpiCredentials,
  partnerId: string,
  preferredVersion: OcpiVersion = '2.2.1',
): Promise<OcpiCredentials> {
  logger.info({ partnerId }, 'Updating credentials');

  const partnerRole = credentials.roles[0];
  if (partnerRole == null) {
    throw new Error('No roles provided in credentials');
  }

  const [current] = await db
    .select({ allowPrivateNetwork: ocpiPartners.allowPrivateNetwork })
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, partnerId))
    .limit(1);

  // Fetch partner endpoints
  const { version, endpoints } = await fetchPartnerEndpoints(
    credentials.url,
    credentials.token,
    preferredVersion,
    current?.allowPrivateNetwork ?? false,
  );

  // Update partner
  await db
    .update(ocpiPartners)
    .set({
      name: partnerRole.business_details.name,
      roles: credentials.roles,
      version,
      versionUrl: credentials.url,
      updatedAt: new Date(),
    })
    .where(eq(ocpiPartners.id, partnerId));

  // Update endpoints
  await db.delete(ocpiPartnerEndpoints).where(eq(ocpiPartnerEndpoints.partnerId, partnerId));

  if (endpoints.length > 0) {
    await db.insert(ocpiPartnerEndpoints).values(
      endpoints.map((ep) => ({
        partnerId,
        module: ep.identifier,
        interfaceRole: ep.role,
        url: ep.url,
      })),
    );
  }

  // Update the token they gave us
  await deactivateTokens(partnerId, 'received');
  const receivedTokenHash = await argon2.hash(credentials.token);
  const encKey2 = getEncryptionKey();
  const outboundTokenEnc2 = encKey2 !== '' ? encryptString(credentials.token, encKey2) : null;
  await db.insert(ocpiCredentialsTokens).values({
    partnerId,
    tokenHash: receivedTokenHash,
    tokenPrefix: credentials.token.slice(0, 8),
    direction: 'received',
    isActive: true,
    outboundTokenEnc: outboundTokenEnc2,
  });

  // Generate new token for them
  await deactivateTokens(partnerId, 'issued');
  const newToken = await generateAndStoreToken(partnerId, 'issued');

  return buildOurCredentials(newToken);
}

export async function handleUnregister(partnerId: string): Promise<void> {
  logger.info({ partnerId }, 'Unregistering partner');

  await db
    .update(ocpiPartners)
    .set({ status: 'disconnected', updatedAt: new Date() })
    .where(eq(ocpiPartners.id, partnerId));

  // Deactivate all tokens for this partner
  await db
    .update(ocpiCredentialsTokens)
    .set({ isActive: false })
    .where(
      and(eq(ocpiCredentialsTokens.partnerId, partnerId), eq(ocpiCredentialsTokens.isActive, true)),
    );
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
  );

  const credentialsEndpoint = endpoints.find((ep) => ep.identifier === 'credentials');
  if (credentialsEndpoint == null) {
    throw new Error('Partner does not expose a credentials endpoint');
  }

  // Generate Token A — the token partner will use to call us going forward
  // (issued = we issued it for their inbound calls).
  await deactivateTokens(partnerId, 'issued');
  const tokenA = await generateAndStoreToken(partnerId, 'issued');
  const ourCredentials = buildOurCredentials(tokenA);

  // Step 3: POST our credentials using Token C as bearer
  const client = new OcpiClient({
    token: tokenC,
    fromCountryCode: getOurCountryCode(),
    fromPartyId: getOurPartyId(),
    toCountryCode: partner.countryCode,
    toPartyId: partner.partyId,
    allowPrivateNetwork: partner.allowPrivateNetwork,
  });

  const response = await client.post<OcpiCredentials>(credentialsEndpoint.url, ourCredentials);
  const theirCredentials = response.data as OcpiCredentials | null;

  if (theirCredentials == null) {
    throw new Error('Partner returned no credentials');
  }

  // Step 4: store Token B (their token for us to use on outbound calls).
  // 'received' direction = token we received from them, use for outbound.
  await deactivateTokens(partnerId, 'received');
  const tokenBHash = await argon2.hash(theirCredentials.token);
  const tokenBEnc = encryptString(theirCredentials.token, encKey);
  await db.insert(ocpiCredentialsTokens).values({
    partnerId,
    tokenHash: tokenBHash,
    tokenPrefix: theirCredentials.token.slice(0, 8),
    direction: 'received',
    isActive: true,
    outboundTokenEnc: tokenBEnc,
  });

  // Replace endpoints from the credentials response (the partner may return
  // a new versions URL or updated endpoint list).
  await db.delete(ocpiPartnerEndpoints).where(eq(ocpiPartnerEndpoints.partnerId, partnerId));

  const { endpoints: newEndpoints } = await fetchPartnerEndpoints(
    theirCredentials.url,
    theirCredentials.token,
    version,
    partner.allowPrivateNetwork,
  );

  if (newEndpoints.length > 0) {
    await db.insert(ocpiPartnerEndpoints).values(
      newEndpoints.map((ep) => ({
        partnerId,
        module: ep.identifier,
        interfaceRole: ep.role,
        url: ep.url,
      })),
    );
  }

  // Step 5: Token C is now retired; clear the stored ciphertext.
  await db
    .update(ocpiPartners)
    .set({
      status: 'connected',
      version,
      versionUrl: theirCredentials.url,
      partnerRegistrationTokenEnc: null,
      updatedAt: new Date(),
    })
    .where(eq(ocpiPartners.id, partnerId));

  return theirCredentials;
}
