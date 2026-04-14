// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';

export type SimRole = 'emsp' | 'cpo';

export interface PartnerEndpoint {
  identifier: string;
  role: 'SENDER' | 'RECEIVER';
  url: string;
}

export interface ReceivedSession {
  sessionId: string;
  status: string;
  kwh: number;
  receivedAt: string;
}

export interface ReceivedCdr {
  cdrId: string;
  totalEnergy: number;
  totalCost: string | null;
  receivedAt: string;
}

export interface ReceivedLocation {
  locationId: string;
  name: string | null;
  evseCount: number;
  receivedAt: string;
}

export interface ReceivedCommand {
  command: string;
  body: unknown;
  receivedAt: string;
}

export interface ReceivedToken {
  uid: string;
  contractId: string;
  isValid: boolean;
  receivedAt: string;
}

export interface CommandResult {
  commandId: string;
  result: string;
  receivedAt: string;
}

export interface SimState {
  role: SimRole;
  countryCode: string;
  partyId: string;
  name: string;
  baseUrl: string;
  // Our token issued to target; target sends this when calling us
  ourToken: string;
  // Token target issued to us; we send this when calling target
  theirToken: string | null;
  isRegistered: boolean;
  // Discovered target module endpoints
  partnerEndpoints: PartnerEndpoint[];
  // Test data (what we serve / push)
  testTokenUid: string;
  // Received data (what target pushed to us)
  receivedSessions: ReceivedSession[];
  receivedCdrs: ReceivedCdr[];
  receivedLocations: ReceivedLocation[];
  receivedCommands: ReceivedCommand[];
  receivedTokens: ReceivedToken[];
  commandResults: CommandResult[];
}

function createState(): SimState {
  const role = (process.env['OCPI_SIM_ROLE'] ?? 'emsp') as SimRole;

  return {
    role,
    countryCode: process.env['OCPI_SIM_COUNTRY_CODE'] ?? 'NL',
    partyId: process.env['OCPI_SIM_PARTY_ID'] ?? 'SIM',
    name: process.env['OCPI_SIM_NAME'] ?? 'OCPI Simulator',
    baseUrl: process.env['OCPI_SIM_BASE_URL'] ?? 'http://localhost:7105',
    ourToken: crypto.randomBytes(32).toString('hex'),
    theirToken: null,
    isRegistered: false,
    partnerEndpoints: [],
    testTokenUid: process.env['OCPI_SIM_TEST_TOKEN_UID'] ?? 'SIM-TOKEN-001',
    receivedSessions: [],
    receivedCdrs: [],
    receivedLocations: [],
    receivedCommands: [],
    receivedTokens: [],
    commandResults: [],
  };
}

export const state: SimState = createState();

export function findPartnerEndpoint(
  identifier: string,
  role: 'SENDER' | 'RECEIVER',
): string | null {
  return (
    state.partnerEndpoints.find((e) => e.identifier === identifier && e.role === role)?.url ?? null
  );
}
