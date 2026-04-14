// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

/**
 * TC_C_50_CS: Authorization using Contract Certificates 15118 - Online - Local contract certificate validation - Accepted
 *
 * Requires ISO 15118 TLS/certificate infrastructure that the test server does not support.
 */
export const TC_C_50_CS: CsTestCase = {
  id: 'TC_C_50_CS',
  name: 'Authorization using Contract Certificates 15118 - Online - Local contract certificate validation - Accepted',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station is able to authorize with contract certificates when it supports ISO 15118.',
  purpose:
    'To verify if the Charging Station is able to authorize while locally validating the contract certificate.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_51_CS: Authorization using Contract Certificates 15118 - Online - Local contract certificate validation - Rejected
 *
 * Requires ISO 15118 TLS/certificate infrastructure that the test server does not support.
 */
export const TC_C_51_CS: CsTestCase = {
  id: 'TC_C_51_CS',
  name: 'Authorization using Contract Certificates 15118 - Online - Local contract certificate validation - Rejected',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station is able to authorize with contract certificates when it supports ISO 15118.',
  purpose:
    'To verify if the Charging Station is able to handle a rejected on an AuthorizeRequest, when authorizing with contract certificates.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_52_CS: Authorization using Contract Certificates 15118 - Online - Central contract certificate validation
 *
 * Requires ISO 15118 TLS/certificate infrastructure that the test server does not support.
 */
export const TC_C_52_CS: CsTestCase = {
  id: 'TC_C_52_CS',
  name: 'Authorization using Contract Certificates 15118 - Online - Central contract certificate validation',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station is able to authorize with contract certificates when it supports ISO 15118.',
  purpose:
    'To verify if the Charging Station is able to authorize, while not being able to locally validate the contract certificate.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_53_CS: Authorization using Contract Certificates 15118 - Online - Central contract validation fails
 *
 * Requires ISO 15118 TLS/certificate infrastructure that the test server does not support.
 */
export const TC_C_53_CS: CsTestCase = {
  id: 'TC_C_53_CS',
  name: 'Authorization using Contract Certificates 15118 - Online - Central contract validation fails',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station is able to authorize with contract certificates when it supports ISO 15118.',
  purpose: 'To verify if the Charging Station is able to handle an invalid contract certificate.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_54_CS: Authorization using Contract Certificates 15118 - Offline - ContractValidationOffline is true
 *
 * Requires ISO 15118 TLS/certificate infrastructure that the test server does not support.
 */
export const TC_C_54_CS: CsTestCase = {
  id: 'TC_C_54_CS',
  name: 'Authorization using Contract Certificates 15118 - Offline - ContractValidationOffline is true',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station is able to authorize with contract certificates for an EMAID that exists in authorization while offline.',
  purpose:
    'To verify if the Charging Station is able to authorize using contract certificates, while it is offline.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_55_CS: Authorization using Contract Certificates 15118 - Offline - ContractValidationOffline is false
 *
 * Requires ISO 15118 TLS/certificate infrastructure that the test server does not support.
 */
export const TC_C_55_CS: CsTestCase = {
  id: 'TC_C_55_CS',
  name: 'Authorization using Contract Certificates 15118 - Offline - ContractValidationOffline is false',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The Charging Station will not authorize with contract certificates when offline.',
  purpose:
    'To verify if the Charging Station is able to handle being offline and not allowing a charging session to start.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
