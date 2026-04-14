// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { db, ocpiPartners, ocpiPartnerEndpoints, ocpiCredentialsTokens } from '@evtivity/database';
import { eq, and } from 'drizzle-orm';
import { createLogger, encryptString } from '@evtivity/lib';
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

async function deactivateTokenById(tokenId: number): Promise<void> {
  await db
    .update(ocpiCredentialsTokens)
    .set({ isActive: false })
    .where(eq(ocpiCredentialsTokens.id, tokenId));
}

async function fetchPartnerEndpoints(
  versionsUrl: string,
  token: string,
  preferredVersion: OcpiVersion,
): Promise<{ version: OcpiVersion; endpoints: OcpiVersionDetail['endpoints'] }> {
  const client = new OcpiClient({
    token,
    fromCountryCode: getOurCountryCode(),
    fromPartyId: getOurPartyId(),
    toCountryCode: '',
    toPartyId: '',
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
): Promise<OcpiCredentials> {
  logger.info({ url: credentials.url, roles: credentials.roles }, 'Processing registration');

  const partnerRole = credentials.roles[0];
  if (partnerRole == null) {
    throw new Error('No roles provided in credentials');
  }

  // Fetch partner version and endpoints
  const { version, endpoints } = await fetchPartnerEndpoints(
    credentials.url,
    credentials.token,
    '2.2.1',
  );

  // Create or update partner
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
        interfaceRole: ep.role as 'SENDER' | 'RECEIVER',
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

  // Deactivate the registration token
  await deactivateTokenById(registrationTokenId);

  return buildOurCredentials(newToken);
}

export async function handleCredentialUpdate(
  credentials: OcpiCredentials,
  partnerId: string,
): Promise<OcpiCredentials> {
  logger.info({ partnerId }, 'Updating credentials');

  const partnerRole = credentials.roles[0];
  if (partnerRole == null) {
    throw new Error('No roles provided in credentials');
  }

  // Fetch partner endpoints
  const { version, endpoints } = await fetchPartnerEndpoints(
    credentials.url,
    credentials.token,
    '2.2.1',
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
        interfaceRole: ep.role as 'SENDER' | 'RECEIVER',
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

export async function initiateRegistration(
  partnerId: string,
  partnerVersionsUrl: string,
): Promise<OcpiCredentials> {
  logger.info({ partnerId, url: partnerVersionsUrl }, 'Initiating outbound registration');

  const [partner] = await db
    .select()
    .from(ocpiPartners)
    .where(eq(ocpiPartners.id, partnerId))
    .limit(1);

  if (partner == null) {
    throw new Error('Partner not found');
  }

  // Get our registration token for calling them
  const tokenRows = await db
    .select({ tokenHash: ocpiCredentialsTokens.tokenHash })
    .from(ocpiCredentialsTokens)
    .where(
      and(
        eq(ocpiCredentialsTokens.partnerId, partnerId),
        eq(ocpiCredentialsTokens.direction, 'issued'),
        eq(ocpiCredentialsTokens.isActive, true),
      ),
    )
    .limit(1);

  if (tokenRows.length === 0 || tokenRows[0] == null) {
    throw new Error('No active token for partner. Create a registration token first.');
  }

  // Fetch their versions and find credentials endpoint
  const { version, endpoints } = await fetchPartnerEndpoints(
    partnerVersionsUrl,
    '', // We need the plain token, not the hash
    '2.2.1',
  );

  const credentialsEndpoint = endpoints.find((ep) => ep.identifier === 'credentials');
  if (credentialsEndpoint == null) {
    throw new Error('Partner does not expose a credentials endpoint');
  }

  // Generate token for them to call us (issued = we issue it for their inbound calls)
  await deactivateTokens(partnerId, 'issued');
  const tokenForPartner = await generateAndStoreToken(partnerId, 'issued');
  const ourCredentials = buildOurCredentials(tokenForPartner);

  // POST our credentials to their credentials endpoint
  const client = new OcpiClient({
    token: '', // Uses the registration token
    fromCountryCode: getOurCountryCode(),
    fromPartyId: getOurPartyId(),
    toCountryCode: partner.countryCode,
    toPartyId: partner.partyId,
  });

  const response = await client.post<OcpiCredentials>(credentialsEndpoint.url, ourCredentials);
  const theirCredentials = response.data as OcpiCredentials | null;

  if (theirCredentials == null) {
    throw new Error('Partner returned no credentials');
  }

  // Store their new token for us to call them
  // Note: in outbound registration the token they return is for us to call them,
  // which is stored as 'received' direction (we received it from them for outbound use)
  await deactivateTokens(partnerId, 'received');
  const receivedHash = await argon2.hash(theirCredentials.token);
  const encKey3 = getEncryptionKey();
  const outboundTokenEnc3 = encKey3 !== '' ? encryptString(theirCredentials.token, encKey3) : null;
  await db.insert(ocpiCredentialsTokens).values({
    partnerId,
    tokenHash: receivedHash,
    tokenPrefix: theirCredentials.token.slice(0, 8),
    direction: 'received',
    isActive: true,
    outboundTokenEnc: outboundTokenEnc3,
  });

  // Update partner status and endpoints
  await db.delete(ocpiPartnerEndpoints).where(eq(ocpiPartnerEndpoints.partnerId, partnerId));

  // Re-fetch endpoints with the new token
  const { endpoints: newEndpoints } = await fetchPartnerEndpoints(
    theirCredentials.url,
    theirCredentials.token,
    version,
  );

  if (newEndpoints.length > 0) {
    await db.insert(ocpiPartnerEndpoints).values(
      newEndpoints.map((ep) => ({
        partnerId,
        module: ep.identifier,
        interfaceRole: ep.role as 'SENDER' | 'RECEIVER',
        url: ep.url,
      })),
    );
  }

  await db
    .update(ocpiPartners)
    .set({
      status: 'connected',
      version,
      versionUrl: theirCredentials.url,
      updatedAt: new Date(),
    })
    .where(eq(ocpiPartners.id, partnerId));

  return theirCredentials;
}
