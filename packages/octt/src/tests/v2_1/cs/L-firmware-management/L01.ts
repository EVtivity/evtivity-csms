// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import type { TestResult } from '../../../../types.js';
import {
  sleep,
  startFileServer,
  waitForChargingState,
  type FileServer,
} from '../../../../cs-test-helpers.js';
import {
  BROKEN_FIRMWARE_IMAGE_BASE64,
  BROKEN_FIRMWARE_SIGNATURE,
  EXPIRED_FIRMWARE_SIGNING_CERTIFICATE,
  FIRMWARE_IMAGE_BASE64,
  FIRMWARE_SIGNATURE,
  FIRMWARE_SIGNING_CERTIFICATE,
  INVALID_FIRMWARE_SIGNATURE,
} from '../../../../firmware-fixtures.js';

const MODULE = 'L-firmware-management';
const TOKEN = 'OCTT-TOKEN-001';
const TOKEN2 = 'OCTT-TOKEN-002';
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const passOrFail = (ok: boolean): 'passed' | 'failed' => (ok ? 'passed' : 'failed');
const isoOffset = (ms: number): string => new Date(Date.now() + ms).toISOString();

function useCsmsHandler(ctx: CsTestContext): void {
  ctx.server.setMessageHandler(async (action: string) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    return {};
  });
}

/** <Configured firmware_location> (and the broken image for TC_L_08). */
async function serveFirmware(): Promise<{ valid: FileServer; broken: FileServer }> {
  const valid = await startFileServer(
    '/firmware/css-firmware.bin',
    Buffer.from(FIRMWARE_IMAGE_BASE64, 'base64'),
  );
  const broken = await startFileServer(
    '/firmware/css-firmware-broken.bin',
    Buffer.from(BROKEN_FIRMWARE_IMAGE_BASE64, 'base64'),
  );
  return { valid, broken };
}

interface FirmwareRequest {
  requestId: number;
  location: string;
  retrieveDateTime?: string | undefined;
  installDateTime?: string | undefined;
  signingCertificate?: string | undefined;
  signature?: string | undefined;
}

async function updateFirmware(
  ctx: CsTestContext,
  req: FirmwareRequest,
): Promise<Record<string, unknown>> {
  const firmware: Record<string, unknown> = {
    location: req.location,
    retrieveDateTime: req.retrieveDateTime ?? isoOffset(-TWO_HOURS_MS),
    installDateTime: req.installDateTime ?? isoOffset(-TWO_HOURS_MS),
  };
  if (req.signingCertificate != null) firmware['signingCertificate'] = req.signingCertificate;
  if (req.signature != null) firmware['signature'] = req.signature;
  return ctx.server.sendCommand('UpdateFirmware', { requestId: req.requestId, firmware });
}

/**
 * Collects FirmwareStatusNotificationRequests until one of `final` arrives or
 * the timeout passes. Returns `status` or `status#requestId` entries in order.
 */
async function firmwareStatuses(
  ctx: CsTestContext,
  final: string[],
  timeoutMs: number,
): Promise<Array<{ status: string; requestId: unknown }>> {
  const seen: Array<{ status: string; requestId: unknown }> = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let msg: Record<string, unknown>;
    try {
      msg = await ctx.server.waitForMessage('FirmwareStatusNotification', deadline - Date.now());
    } catch {
      break;
    }
    seen.push({ status: String(msg['status']), requestId: msg['requestId'] });
    if (final.includes(String(msg['status']))) break;
  }
  return seen;
}

/** True when `expected` appears in `seen` in this order (other statuses in between allowed). */
function inOrder(seen: string[], expected: string[]): boolean {
  let i = 0;
  for (const s of seen) if (s === expected[i]) i++;
  return i === expected.length;
}

async function securityEvent(
  ctx: CsTestContext,
  type: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const msg = await ctx.server.waitForMessage(
        'SecurityEventNotification',
        deadline - Date.now(),
      );
      if (msg['type'] === type) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function responseStep(step: number, resp: Record<string, unknown>, expected: string[]): StepResult {
  return {
    step,
    description: `UpdateFirmwareResponse status ${expected.join(' or ')}`,
    status: passOrFail(expected.includes(String(resp['status']))),
    expected: expected.join(' or '),
    actual: `status ${String(resp['status'])}`,
  };
}

function sequenceStep(
  step: number,
  seen: Array<{ status: string }>,
  expected: string[],
): StepResult {
  const statuses = seen.map((s) => s.status);
  return {
    step,
    description: `FirmwareStatusNotificationRequests ${expected.join(', ')}`,
    status: passOrFail(inOrder(statuses, expected)),
    expected: expected.join(' -> '),
    actual: statuses.join(' -> ') || 'none',
  };
}

async function securityStep(
  ctx: CsTestContext,
  step: number,
  type: string,
  timeoutMs = 10_000,
): Promise<StepResult> {
  const found = await securityEvent(ctx, type, timeoutMs);
  return {
    step,
    description: `SecurityEventNotificationRequest type ${type}`,
    status: passOrFail(found),
    expected: `type ${type}`,
    actual: found ? `type ${type}` : 'not received',
  };
}

const result = (steps: StepResult[]): TestResult => ({
  status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
  durationMs: 0,
  steps,
});

/** Reusable State EnergyTransferStarted on an EVSE; returns false when not reached. */
async function energyTransferStarted(
  ctx: CsTestContext,
  evseId: number,
  token: string,
  steps: StepResult[],
): Promise<boolean> {
  await ctx.station.plugIn(evseId);
  await ctx.station.authorize(evseId, token);
  const charging = await waitForChargingState(ctx.server, 'Charging', 10_000);
  steps.push({
    step: 0,
    description: `Reusable State EnergyTransferStarted on EVSE ${String(evseId)}`,
    status: passOrFail(charging != null),
    expected: 'chargingState Charging',
    actual: charging != null ? 'Charging' : 'not received',
  });
  return charging != null;
}

/** Reusable State ParkingBayUnoccupied: present the idToken (stop) and unplug. */
async function parkingBayUnoccupied(
  ctx: CsTestContext,
  evseId: number,
  token: string,
): Promise<void> {
  await ctx.station.authorize(evseId, token);
  await ctx.station.unplug(evseId);
}

/** The installation part of a successful update: Installing, Installed, FirmwareUpdated, BootNotification. */
async function installedSteps(
  ctx: CsTestContext,
  steps: StepResult[],
  seenBefore: Array<{ status: string; requestId: unknown }>,
  firstStep: number,
): Promise<void> {
  const seen = [...seenBefore, ...(await firmwareStatuses(ctx, ['Installed'], 30_000))];
  steps.push(sequenceStep(firstStep, seen, ['Installing', 'Installed']));
  let boot: Record<string, unknown> | null = null;
  try {
    boot = await ctx.server.waitForMessage('BootNotification', 5000);
  } catch {
    boot = null;
  }
  steps.push({
    step: firstStep + 1,
    description: 'Charging Station reboots to activate the firmware (BootNotificationRequest)',
    status: passOrFail(boot != null),
    expected: 'BootNotificationRequest',
    actual: boot != null ? `reason ${String(boot['reason'])}` : 'not received',
  });
  steps.push(await securityStep(ctx, firstStep + 2, 'FirmwareUpdated'));
}

const create = (
  id: string,
  name: string,
  purpose: string,
  execute: (ctx: CsTestContext) => Promise<TestResult>,
  extra: Partial<CsTestCase> = {},
): CsTestCase => ({
  id,
  name,
  module: MODULE,
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS requests the Charging Station to securely download and install a new firmware by sending an UpdateFirmwareRequest with a signingCertificate.',
  purpose,
  timeoutMs: 180_000,
  execute,
  ...extra,
});

/** TC_L_01/02/03: a successful update, optionally with a future retrieve or install time. */
function successfulUpdate(schedule: 'none' | 'install' | 'download') {
  return async (ctx: CsTestContext): Promise<TestResult> => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const files = await serveFirmware();
    try {
      const resp = await updateFirmware(ctx, {
        requestId: 1,
        location: files.valid.url,
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: FIRMWARE_SIGNATURE,
        retrieveDateTime: schedule === 'download' ? isoOffset(5000) : undefined,
        installDateTime: schedule === 'install' ? isoOffset(5000) : undefined,
      });
      steps.push(responseStep(2, resp, ['Accepted']));
      const expected =
        schedule === 'download'
          ? ['DownloadScheduled', 'Downloading', 'Downloaded', 'SignatureVerified']
          : schedule === 'install'
            ? ['Downloading', 'Downloaded', 'SignatureVerified', 'InstallScheduled']
            : ['Downloading', 'Downloaded', 'SignatureVerified'];
      const seen = await firmwareStatuses(ctx, [expected[expected.length - 1] as string], 30_000);
      steps.push(sequenceStep(3, seen, expected));
      await installedSteps(ctx, steps, [], 12);
    } finally {
      await files.valid.close();
      await files.broken.close();
    }
    return result(steps);
  };
}

export const TC_L_01_CS = create(
  'TC_L_01_CS',
  'Secure Firmware Update - Installation successful',
  'To verify if the Charging Station is able to securely download and install a new firmware.',
  successfulUpdate('none'),
);

export const TC_L_02_CS = create(
  'TC_L_02_CS',
  'Secure Firmware Update - InstallScheduled',
  'To verify if the Charging Station is able to securely download a new firmware and schedule its installation.',
  successfulUpdate('install'),
);

export const TC_L_03_CS = create(
  'TC_L_03_CS',
  'Secure Firmware Update - DownloadScheduled',
  'To verify if the Charging Station is able to schedule securely downloading a new firmware.',
  successfulUpdate('download'),
);

export const TC_L_05_CS = create(
  'TC_L_05_CS',
  'Secure Firmware Update - InvalidCertificate',
  'To verify if the Charging Station is able to identify it receiving an invalid signing certificate and report this to the CSMS.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const files = await serveFirmware();
    try {
      // <Generated invalid firmware signingCertificate>: issued by the trusted
      // manufacturer root, but expired.
      const resp = await updateFirmware(ctx, {
        requestId: 1,
        location: files.valid.url,
        signingCertificate: EXPIRED_FIRMWARE_SIGNING_CERTIFICATE,
        signature: FIRMWARE_SIGNATURE,
      });
      steps.push(responseStep(2, resp, ['InvalidCertificate', 'RevokedCertificate']));
      steps.push(await securityStep(ctx, 3, 'InvalidFirmwareSigningCertificate'));
    } finally {
      await files.valid.close();
      await files.broken.close();
    }
    return result(steps);
  },
);

export const TC_L_06_CS = create(
  'TC_L_06_CS',
  'Secure Firmware Update - InvalidSignature',
  'To verify if the Charging Station is able to identify if the signature is invalid and report this to the CSMS.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const files = await serveFirmware();
    try {
      const resp = await updateFirmware(ctx, {
        requestId: 1,
        location: files.valid.url,
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: INVALID_FIRMWARE_SIGNATURE,
      });
      steps.push(responseStep(2, resp, ['Accepted']));
      const seen = await firmwareStatuses(ctx, ['InvalidSignature'], 30_000);
      steps.push(sequenceStep(3, seen, ['Downloading', 'Downloaded', 'InvalidSignature']));
      steps.push(await securityStep(ctx, 9, 'InvalidFirmwareSignature'));
    } finally {
      await files.valid.close();
      await files.broken.close();
    }
    return result(steps);
  },
);

export const TC_L_07_CS = create(
  'TC_L_07_CS',
  'Secure Firmware Update - DownloadFailed',
  'To verify if the Charging Station is able to report to the CSMS when it is unable to download the new firmware.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const files = await serveFirmware();
    try {
      const resp = await updateFirmware(ctx, {
        requestId: 1,
        location: `${files.valid.url}_does_not_exist`,
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: FIRMWARE_SIGNATURE,
      });
      steps.push(responseStep(2, resp, ['Accepted']));
      const seen = await firmwareStatuses(ctx, ['DownloadFailed'], 60_000);
      steps.push(sequenceStep(3, seen, ['Downloading', 'DownloadFailed']));
    } finally {
      await files.valid.close();
      await files.broken.close();
    }
    return result(steps);
  },
);

export const TC_L_08_CS = create(
  'TC_L_08_CS',
  'Secure Firmware Update - InstallVerificationFailed or InstallationFailed',
  'To verify if the Charging Station is able to report to the CSMS when the firmware verification fails.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const files = await serveFirmware();
    try {
      const resp = await updateFirmware(ctx, {
        requestId: 1,
        location: files.broken.url,
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: BROKEN_FIRMWARE_SIGNATURE,
      });
      steps.push(responseStep(2, resp, ['Accepted']));
      const seen = await firmwareStatuses(
        ctx,
        ['InstallVerificationFailed', 'InstallationFailed'],
        30_000,
      );
      const statuses = seen.map((s) => s.status);
      steps.push(
        sequenceStep(3, seen, ['Downloading', 'Downloaded', 'SignatureVerified', 'Installing']),
      );
      steps.push({
        step: 16,
        description:
          'FirmwareStatusNotificationRequest InstallVerificationFailed or InstallationFailed',
        status: passOrFail(
          statuses.includes('InstallVerificationFailed') || statuses.includes('InstallationFailed'),
        ),
        expected: 'InstallVerificationFailed or InstallationFailed',
        actual: statuses.join(' -> ') || 'none',
      });
    } finally {
      await files.valid.close();
      await files.broken.close();
    }
    return result(steps);
  },
);

export const TC_L_10_CS = create(
  'TC_L_10_CS',
  'Secure Firmware Update - AcceptedCanceled',
  'To verify if the Charging Station can cancel an ongoing firmware update and start a new one.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const files = await serveFirmware();
    try {
      // The first request is still busy (its download is scheduled) when the second arrives.
      const first = await updateFirmware(ctx, {
        requestId: 1,
        location: files.valid.url,
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: FIRMWARE_SIGNATURE,
        retrieveDateTime: isoOffset(60_000),
      });
      steps.push(responseStep(2, first, ['Accepted']));
      const firstStatus = await firmwareStatuses(ctx, ['DownloadScheduled', 'Downloading'], 10_000);
      const busy = firstStatus.find((s) => s.requestId === 1);
      steps.push({
        step: 3,
        description: 'FirmwareStatusNotificationRequest for requestId 1 (busy)',
        status: passOrFail(busy != null),
        expected: 'requestId 1, DownloadScheduled or Downloading',
        actual: firstStatus.map((s) => `${s.status}#${String(s.requestId)}`).join(', ') || 'none',
      });
      const second = await updateFirmware(ctx, {
        requestId: 2,
        location: files.valid.url,
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: FIRMWARE_SIGNATURE,
      });
      steps.push(responseStep(6, second, ['AcceptedCanceled']));
      const seen = await firmwareStatuses(ctx, ['SignatureVerified'], 30_000);
      const ofSecond = seen.filter((s) => s.requestId === 2);
      steps.push(sequenceStep(7, ofSecond, ['Downloading', 'Downloaded', 'SignatureVerified']));
      const laterFirst = seen.filter(
        (s) =>
          s.requestId === 1 && s.status !== 'DownloadFailed' && s.status !== 'InstallationFailed',
      );
      steps.push({
        step: 7,
        description: 'After step 6 notifications refer to requestId 2',
        status: passOrFail(laterFirst.length === 0),
        expected: 'no further progress for requestId 1',
        actual: laterFirst.map((s) => `${s.status}#1`).join(', ') || 'none',
      });
      await installedSteps(ctx, steps, [], 16);
    } finally {
      await files.valid.close();
      await files.broken.close();
    }
    return result(steps);
  },
);

export const TC_L_11_CS = create(
  'TC_L_11_CS',
  'Secure Firmware Update - Unable to cancel',
  'To verify if the Charging Station rejects a new firmware update while it cannot cancel the ongoing one.',
  async (ctx) => {
    // Applies only to a station that cannot cancel an ongoing update (NOT
    // PICS C-60); the runner reports it notApplicable for the simulator.
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const files = await serveFirmware();
    try {
      const first = await updateFirmware(ctx, {
        requestId: 1,
        location: files.valid.url,
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: FIRMWARE_SIGNATURE,
      });
      steps.push(responseStep(2, first, ['Accepted']));
      await firmwareStatuses(ctx, ['Downloading'], 10_000);
      const second = await updateFirmware(ctx, {
        requestId: 2,
        location: files.valid.url,
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: FIRMWARE_SIGNATURE,
      });
      steps.push(responseStep(6, second, ['Rejected']));
    } finally {
      await files.valid.close();
      await files.broken.close();
    }
    return result(steps);
  },
);

/**
 * TC_L_12-TC_L_15: an update requested during a transaction. The download
 * runs during the transaction (PICS AQ-7); the installation waits until the
 * transactions ended (PICS C-43 not supported).
 */
function updateDuringTransaction(allowNewSessions: boolean, secondTransaction: boolean) {
  return async (ctx: CsTestContext): Promise<TestResult> => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const files = await serveFirmware();
    try {
      const config = await ctx.server.sendCommand('SetVariables', {
        setVariableData: [
          {
            component: { name: 'ChargingStation' },
            variable: { name: 'AllowNewSessionsPendingFirmwareUpdate' },
            attributeValue: allowNewSessions ? 'true' : 'false',
          },
        ],
      });
      const configResult = (
        (config['setVariableResult'] ?? []) as Array<Record<string, unknown>>
      )[0];
      steps.push({
        step: 0,
        description: `Before: AllowNewSessionsPendingFirmwareUpdate ${String(allowNewSessions)}`,
        status: passOrFail(configResult?.['attributeStatus'] === 'Accepted'),
        expected: 'Accepted',
        actual: String(configResult?.['attributeStatus']),
      });
      if (!(await energyTransferStarted(ctx, 1, TOKEN, steps))) return result(steps);

      const resp = await updateFirmware(ctx, {
        requestId: 1,
        location: files.valid.url,
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: FIRMWARE_SIGNATURE,
      });
      steps.push(responseStep(2, resp, ['Accepted']));
      const seen = await firmwareStatuses(ctx, ['InstallScheduled', 'Installing'], 30_000);
      steps.push(sequenceStep(3, seen, ['Downloading', 'Downloaded', 'SignatureVerified']));
      const last = seen[seen.length - 1]?.status;
      steps.push({
        step: 9,
        description: 'FirmwareStatusNotificationRequest InstallScheduled or Installing',
        status: passOrFail(last === 'InstallScheduled' || last === 'Installing'),
        expected: 'InstallScheduled or Installing',
        actual: String(last),
      });

      // Step 11 (AllowNewSessionsPendingFirmwareUpdate false): connectors that
      // are Available become Unavailable. These tests run on a one-EVSE station
      // whose only connector is in the transaction, so there is none.
      if (secondTransaction) {
        // Step 11: a second transaction may start while the update waits.
        if (!(await energyTransferStarted(ctx, 2, TOKEN2, steps))) return result(steps);
      }
      // ParkingBayUnoccupied for the transaction(s): the installation follows.
      await parkingBayUnoccupied(ctx, 1, TOKEN);
      if (secondTransaction) {
        await sleep(1000);
        const stillWaiting = await firmwareStatuses(ctx, ['Installing'], 3000);
        steps.push({
          step: 12,
          description: 'No installation while the second transaction runs',
          status: passOrFail(!stillWaiting.some((s) => s.status === 'Installing')),
          expected: 'no Installing',
          actual: stillWaiting.map((s) => s.status).join(', ') || 'none',
        });
        await parkingBayUnoccupied(ctx, 2, TOKEN2);
      }
      await installedSteps(ctx, steps, [], 17);
    } finally {
      await files.valid.close();
      await files.broken.close();
    }
    return result(steps);
  };
}

export const TC_L_12_CS = create(
  'TC_L_12_CS',
  'Secure Firmware Update - Unable to download/install firmware with ongoing transaction - AllowNewSessionsPendingFirmwareUpdate is true',
  'To verify if the Charging Station waits with downloading and installing a firmware until the ongoing transactions ended.',
  updateDuringTransaction(true, true),
  { stationConfig: { evseCount: 2 } },
);

export const TC_L_13_CS = create(
  'TC_L_13_CS',
  'Secure Firmware Update - Unable to download/install firmware with ongoing transaction - AllowNewSessionsPendingFirmwareUpdate is false',
  'To verify if the Charging Station waits with downloading and installing a firmware until the ongoing transaction ended.',
  updateDuringTransaction(false, false),
);

export const TC_L_14_CS = create(
  'TC_L_14_CS',
  'Secure Firmware Update - Unable to install and activate firmware with ongoing transaction - AllowNewSessionsPendingFirmwareUpdate is true',
  'To verify if the Charging Station downloads a firmware during a transaction and installs it once the transactions ended, allowing new sessions meanwhile.',
  updateDuringTransaction(true, true),
  { stationConfig: { evseCount: 2 } },
);

export const TC_L_15_CS = create(
  'TC_L_15_CS',
  'Secure Firmware Update - Unable to install and activate firmware with ongoing transaction - AllowNewSessionsPendingFirmwareUpdate is false',
  'To verify if the Charging Station downloads a firmware during a transaction and installs it once the transaction ended.',
  updateDuringTransaction(false, false),
);

export const TC_L_16_CS = create(
  'TC_L_16_CS',
  'Secure Firmware Update - Able to update firmware with ongoing transaction',
  'To verify if the Charging Station installs a firmware during an ongoing transaction.',
  async (ctx) => {
    // Applies only to a station that installs with ongoing transactions (PICS
    // C-43); the runner reports it notApplicable for the simulator.
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const files = await serveFirmware();
    try {
      if (!(await energyTransferStarted(ctx, 1, TOKEN, steps))) return result(steps);
      const resp = await updateFirmware(ctx, {
        requestId: 1,
        location: files.valid.url,
        signingCertificate: FIRMWARE_SIGNING_CERTIFICATE,
        signature: FIRMWARE_SIGNATURE,
      });
      steps.push(responseStep(2, resp, ['Accepted']));
      await installedSteps(ctx, steps, [], 12);
    } finally {
      await files.valid.close();
      await files.broken.close();
    }
    return result(steps);
  },
);

export const TC_L_18_CS = create(
  'TC_L_18_CS',
  'Secure Firmware Update - Missing firmware signing certificate and signature',
  'To verify if the Charging Station rejects a firmware update without signing certificate and signature (secure firmware update).',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const files = await serveFirmware();
    try {
      const resp = await updateFirmware(ctx, { requestId: 1, location: files.valid.url });
      steps.push(responseStep(2, resp, ['Rejected', 'InvalidCertificate']));
    } finally {
      await files.valid.close();
      await files.broken.close();
    }
    return result(steps);
  },
);
