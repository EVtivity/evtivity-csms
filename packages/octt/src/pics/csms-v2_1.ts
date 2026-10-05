// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Pics, PicsItem, PicsPrerequisite } from './types.js';

/**
 * PICS of the EVtivity CSMS for OCPP 2.1 (the CSMS runner's Device Under
 * Test).
 *
 * Part 5 Table 3 lists the optional CSMS features, and chapter 4 marks each
 * CSMS test mandatory or conditional per certification profile. Contract
 * certificate installation and update for the EV (TC_M_26, TC_M_28,
 * TC_M_100) belongs to the "ISO 15118 support" profile (Table 1, "ISO 15118
 * Certificate Management: (Contract) Certificate Installation / Update EV")
 * and has no CSMS feature id of its own, so the item uses a descriptive key.
 * The CSMS supports it through the local contract CA (`pnc.provider =
 * 'local'`). Only items that decide whether a CSMS test applies are listed.
 * Every unsupported item says why.
 */
const items: Record<string, PicsItem> = {
  ContractCertificateInstallationEV: {
    id: 'ContractCertificateInstallationEV',
    description:
      'ISO 15118 support: (Contract) Certificate Installation / Update EV (Get15118EVCertificate), issued by the local contract CA. Part 5 lists TC_M_26 and TC_M_28 under ISO-1.1 (ISO 15118-2) and TC_M_100 under ISO-1.2 (ISO 15118-20)',
    supported: true,
  },
};

const testPrerequisites: Record<string, PicsPrerequisite[]> = Object.fromEntries(
  ['TC_M_26_CSMS', 'TC_M_28_CSMS', 'TC_M_100_CSMS'].map((id) => [
    id,
    [{ item: 'ContractCertificateInstallationEV', requires: true }],
  ]),
);

export const PICS_CSMS_V2_1: Pics = {
  sut: 'csms',
  version: 'ocpp2.1',
  items,
  testPrerequisites,
};
