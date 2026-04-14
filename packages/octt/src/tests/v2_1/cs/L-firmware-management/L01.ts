// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

const createSkippedFirmwareTest = (
  id: string,
  name: string,
  description: string,
  purpose: string,
): CsTestCase => ({
  id,
  name,
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'cs',
  description,
  purpose,
  execute: async (_ctx) => ({ status: 'skipped' as const, durationMs: 0, steps: [] }),
});

export const TC_L_01_CS = createSkippedFirmwareTest(
  'TC_L_01_CS',
  'Secure Firmware Update - Installation successful',
  'The CSMS requests the Charging Station to securely download and install a new firmware.',
  'To verify if the Charging Station is able to securely download and install a new firmware.',
);

export const TC_L_02_CS = createSkippedFirmwareTest(
  'TC_L_02_CS',
  'Secure Firmware Update - InstallScheduled',
  'The CSMS requests the Charging Station to securely download and schedule firmware installation.',
  'To verify if the Charging Station is able to securely download a new firmware and schedule its installation.',
);

export const TC_L_03_CS = createSkippedFirmwareTest(
  'TC_L_03_CS',
  'Secure Firmware Update - DownloadScheduled',
  'The CSMS requests the Charging Station to schedule a firmware download for a future time.',
  'To verify if the Charging Station is able to schedule securely downloading a new firmware.',
);

export const TC_L_05_CS = createSkippedFirmwareTest(
  'TC_L_05_CS',
  'Secure Firmware Update - InvalidCertificate',
  'The CSMS sends an UpdateFirmwareRequest with an invalid signing certificate.',
  'To verify if the Charging Station identifies an invalid signing certificate and reports it.',
);

export const TC_L_06_CS = createSkippedFirmwareTest(
  'TC_L_06_CS',
  'Secure Firmware Update - InvalidSignature',
  'The CSMS sends an UpdateFirmwareRequest with an invalid firmware signature.',
  'To verify if the Charging Station identifies an invalid signature and reports it.',
);

export const TC_L_07_CS = createSkippedFirmwareTest(
  'TC_L_07_CS',
  'Secure Firmware Update - DownloadFailed',
  'The CSMS sends an UpdateFirmwareRequest pointing to a non-existent firmware location.',
  'To verify if the Charging Station reports a download failure.',
);

export const TC_L_08_CS = createSkippedFirmwareTest(
  'TC_L_08_CS',
  'Secure Firmware Update - InstallVerificationFailed or InstallationFailed',
  'The CSMS sends firmware that causes an installation verification failure.',
  'To verify if the Charging Station reports firmware verification failure.',
);

export const TC_L_10_CS = createSkippedFirmwareTest(
  'TC_L_10_CS',
  'Secure Firmware Update - AcceptedCanceled',
  'The CSMS sends a second UpdateFirmwareRequest while a first is in progress.',
  'To verify if the Charging Station can cancel an ongoing firmware update and start a new one.',
);
