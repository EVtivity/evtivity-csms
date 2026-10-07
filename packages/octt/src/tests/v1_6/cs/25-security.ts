// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { CsTestCase, CsTestContext, StepResult } from '../../../cs-types.js';
import {
  certificateHashDataOf,
  createRootCertificate,
  invalidServerCertificates,
  issueCertificate,
  sameHashData,
  signCertificateRequest,
  signData,
  type HashAlgorithm,
  type TestCertificate,
} from '../../../cs-security-pki.js';
import { startFileServer, type FileServer } from '../../../cs-test-helpers.js';
import {
  TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
  TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
  TLS_RSA_WITH_AES_128_GCM_SHA256,
  TLS_RSA_WITH_AES_256_GCM_SHA384,
  type UpgradeAttempt,
} from '../../../cs-server.js';

export const TC_073_CS: CsTestCase = {
  id: 'TC_073_CS',
  name: 'Update Charge Point Password for HTTP Basic Authentication',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System configures a new password for HTTP Basic Authentication.',
  purpose: 'To check if the Charge Point is able to switch to a new Basic Authentication password.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    const resp = await ctx.server.sendCommand('ChangeConfiguration', {
      key: 'AuthorizationKey',
      value: '4F43415F4F4354545F61646D696E5F74657374',
    });
    steps.push({
      step: 2,
      description: 'ChangeConfiguration AuthorizationKey Accepted',
      status: (resp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(resp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

// Answers for the station-initiated messages of the security tests.
function securityHandler(
  overrides: Record<string, Record<string, unknown>> = {},
): (action: string) => Promise<Record<string, unknown>> {
  return (action: string) => {
    const override = overrides[action];
    if (override != null) return Promise.resolve(override);
    if (action === 'BootNotification') {
      return Promise.resolve({
        status: 'Accepted',
        currentTime: new Date().toISOString(),
        interval: 300,
      });
    }
    if (action === 'Heartbeat') return Promise.resolve({ currentTime: new Date().toISOString() });
    if (action === 'SignCertificate') return Promise.resolve({ status: 'Accepted' });
    return Promise.resolve({});
  };
}

function step(
  steps: StepResult[],
  n: number,
  description: string,
  ok: boolean,
  expected: string,
  actual: string,
): boolean {
  steps.push({ step: n, description, status: ok ? 'passed' : 'failed', expected, actual });
  return ok;
}

function result(steps: StepResult[]): {
  status: 'passed' | 'failed';
  durationMs: number;
  steps: StepResult[];
} {
  return {
    status: steps.length > 0 && steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
    durationMs: 0,
    steps,
  };
}

async function waitFor(
  server: CsTestContext['server'],
  action: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return server.waitForMessageOrNull(action, timeoutMs);
}

// Configuration State "CpoName is <The configured Vendor Name>".
async function setCpoName(ctx: CsTestContext, steps: StepResult[]): Promise<void> {
  const resp = await ctx.server.sendCommand('ChangeConfiguration', {
    key: 'CpoName',
    value: 'OCTT',
  });
  step(
    steps,
    0,
    'Before: ChangeConfiguration CpoName = <configured vendor name>',
    resp['status'] === 'Accepted',
    'status = Accepted',
    `status = ${String(resp['status'])}`,
  );
}

// Steps 1-4 of TC_074 and TC_077: trigger the renewal and accept the CSR.
async function triggerCertificateRenewal(
  ctx: CsTestContext,
  steps: StepResult[],
): Promise<string | null> {
  const trigger = await ctx.server.sendCommand('ExtendedTriggerMessage', {
    requestedMessage: 'SignChargePointCertificate',
  });
  step(
    steps,
    2,
    'ExtendedTriggerMessage SignChargePointCertificate (connectorId omitted) is Accepted',
    trigger['status'] === 'Accepted',
    'status = Accepted',
    `status = ${String(trigger['status'])}`,
  );
  const sign = await waitFor(ctx.server, 'SignCertificate', 15_000);
  const csr = sign?.['csr'];
  step(
    steps,
    3,
    'Charge Point sends SignCertificate.req with a CSR (answered Accepted, step 4)',
    typeof csr === 'string' && csr.includes('BEGIN CERTIFICATE REQUEST'),
    'csr is a PEM certificate signing request',
    sign == null ? 'no SignCertificate.req' : `csr = ${String(csr).slice(0, 40)}...`,
  );
  return typeof csr === 'string' ? csr : null;
}

export const TC_074_CS: CsTestCase = {
  id: 'TC_074_CS',
  name: 'Update Charge Point Certificate by request of Central System',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The CS requests the Charge Point to renew its certificate.',
  purpose:
    'To test if the Charge Point renews its ChargePointCertificate when the Central System requests it.',
  tls: true,
  stationConfig: { securityProfile: 3, vendorName: 'OCTT' },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const tls = ctx.tls;
    if (tls == null) throw new Error('TC_074_CS needs the TLS test server');
    ctx.server.setMessageHandler(securityHandler());

    await setCpoName(ctx, steps);
    const csr = await triggerCertificateRenewal(ctx, steps);
    if (csr == null) return result(steps);

    // The tool acts as Certificate Authority Server and signs with its own root.
    let signed: Awaited<ReturnType<typeof signCertificateRequest>>;
    try {
      signed = await signCertificateRequest(csr, tls.root);
    } catch (err) {
      step(
        steps,
        5,
        'Certificate Authority Server signs the CSR',
        false,
        'valid PKCS#10 CSR',
        err instanceof Error ? err.message : String(err),
      );
      return result(steps);
    }
    const handshakesBefore = ctx.server.tlsHandshakes().length;
    const certSigned = await ctx.server.sendCommand('CertificateSigned', {
      certificateChain: signed.chainPem,
    });
    step(
      steps,
      6,
      'CertificateSigned.conf is Accepted',
      certSigned['status'] === 'Accepted',
      'status = Accepted',
      `status = ${String(certSigned['status'])}`,
    );

    // Step 7: the Charge Point reconnects with the new certificate.
    const newCert = Buffer.from(signed.leaf.rawData);
    const deadline = Date.now() + 30_000;
    let reconnected = false;
    while (Date.now() < deadline && !reconnected) {
      reconnected = ctx.server
        .tlsHandshakes()
        .slice(handshakesBefore)
        .some((h) => h.ok && h.clientCertificate?.equals(newCert) === true);
      if (!reconnected) await new Promise((r) => setTimeout(r, 250));
    }
    if (reconnected) await ctx.server.waitForConnection(10_000).catch(() => undefined);
    step(
      steps,
      7,
      'Charge Point reconnects to the Central System with the new certificate',
      reconnected && ctx.server.isConnected,
      'TLS client certificate = certificate from step 5, WebSocket connected',
      reconnected
        ? `reconnected with new certificate (subject ${signed.subject}), connected = ${String(ctx.server.isConnected)}`
        : 'no TLS connection with the new certificate within 30s',
    );
    return result(steps);
  },
};

async function installAndList(
  ctx: CsTestContext,
  certificateType: 'ManufacturerRootCertificate' | 'CentralSystemRootCertificate',
): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  ctx.server.setMessageHandler(securityHandler());
  const root = await createRootCertificate(`OCTT ${certificateType}`);

  const install = await ctx.server.sendCommand('InstallCertificate', {
    certificateType,
    certificate: root.pem,
  });
  step(
    steps,
    2,
    `InstallCertificate ${certificateType} is Accepted`,
    install['status'] === 'Accepted',
    'status = Accepted',
    `status = ${String(install['status'])}`,
  );

  const list = await ctx.server.sendCommand('GetInstalledCertificateIds', { certificateType });
  const expected = certificateHashDataOf(root.cert, root.cert);
  const entries = (list['certificateHashData'] as Array<Record<string, unknown>> | undefined) ?? [];
  const present = entries.some((e) => sameHashData(e, { ...expected }));
  step(
    steps,
    4,
    'GetInstalledCertificateIds.conf is Accepted and includes the installed certificate',
    list['status'] === 'Accepted' && present,
    `status = Accepted, certificateHashData includes serial ${expected.serialNumber}`,
    `status = ${String(list['status'])}, ${String(entries.length)} entries, installed certificate ${present ? 'present' : 'absent'}`,
  );
  return steps;
}

export const TC_075_1_CS: CsTestCase = {
  id: 'TC_075_1_CS',
  name: 'Install certificate - ManufacturerRootCertificate',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Central System requests the Charge Point to install a new manufacturer root certificate.',
  purpose: 'To check if the Charge Point is able to install a certificate.',
  stationConfig: { securityProfile: 2 },
  execute: async (ctx) => result(await installAndList(ctx, 'ManufacturerRootCertificate')),
};

export const TC_075_2_CS: CsTestCase = {
  id: 'TC_075_2_CS',
  name: 'Install certificate - CentralSystemRootCertificate',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Central System requests the Charge Point to install a new Central System root certificate.',
  purpose: 'To check if the Charge Point is able to install a certificate.',
  stationConfig: { securityProfile: 2 },
  execute: async (ctx) => result(await installAndList(ctx, 'CentralSystemRootCertificate')),
};

export const TC_076_CS: CsTestCase = {
  id: 'TC_076_CS',
  name: 'Delete a specific certificate from the Charge Point',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'Delete an installed certificate from the Charge Point.',
  purpose: 'To check if the Charge Point is able to delete an installed certificate.',
  stationConfig: { securityProfile: 2 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(securityHandler());
    const certificateType = 'CentralSystemRootCertificate';
    const configured = await createRootCertificate('OCTT Configured Central System Root CA');

    // Memory State CertificateInstalled: install the configured root unless present.
    const before = await ctx.server.sendCommand('GetInstalledCertificateIds', { certificateType });
    const beforeEntries =
      (before['certificateHashData'] as Array<Record<string, unknown>> | undefined) ?? [];
    // NotFound is the answer when no certificate of the type is installed yet.
    step(
      steps,
      0,
      'Before (CertificateInstalled): GetInstalledCertificateIds.conf',
      before['status'] === 'Accepted' || before['status'] === 'NotFound',
      'status = Accepted (NotFound when none of the type is installed)',
      `status = ${String(before['status'])}`,
    );
    const configuredHash = certificateHashDataOf(configured.cert, configured.cert);
    if (!beforeEntries.some((e) => sameHashData(e, { ...configuredHash }))) {
      const install = await ctx.server.sendCommand('InstallCertificate', {
        certificateType,
        certificate: configured.pem,
      });
      step(
        steps,
        0,
        'Before (CertificateInstalled): InstallCertificate.conf is Accepted',
        install['status'] === 'Accepted',
        'status = Accepted',
        `status = ${String(install['status'])}`,
      );
    }

    const list = await ctx.server.sendCommand('GetInstalledCertificateIds', { certificateType });
    const entries =
      (list['certificateHashData'] as Array<Record<string, unknown>> | undefined) ?? [];
    const algorithm = (entries[0]?.['hashAlgorithm'] as HashAlgorithm | undefined) ?? 'SHA256';
    const target = certificateHashDataOf(configured.cert, configured.cert, algorithm);
    step(
      steps,
      2,
      'GetInstalledCertificateIds.conf lists the configured CentralSystemRootCertificate',
      list['status'] === 'Accepted' && entries.some((e) => sameHashData(e, { ...target })),
      'status = Accepted, configured certificate present',
      `status = ${String(list['status'])}, ${String(entries.length)} entries`,
    );

    const del = await ctx.server.sendCommand('DeleteCertificate', {
      certificateHashData: target,
    });
    step(
      steps,
      4,
      'DeleteCertificate.conf is Accepted',
      del['status'] === 'Accepted',
      'status = Accepted',
      `status = ${String(del['status'])}`,
    );

    const after = await ctx.server.sendCommand('GetInstalledCertificateIds', { certificateType });
    const afterEntries =
      (after['certificateHashData'] as Array<Record<string, unknown>> | undefined) ?? [];
    const stillThere = afterEntries.some((e) => sameHashData(e, { ...target }));
    step(
      steps,
      6,
      'GetInstalledCertificateIds.conf no longer includes the removed certificate',
      !stillThere && (after['status'] === 'Accepted' || after['status'] === 'NotFound'),
      'certificateHashData without the removed certificate',
      `status = ${String(after['status'])}, removed certificate ${stillThere ? 'still listed' : 'absent'}`,
    );
    return result(steps);
  },
};

export const TC_077_CS: CsTestCase = {
  id: 'TC_077_CS',
  name: 'Invalid ChargePointCertificate Security Event',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point notifies the Central System of an invalid certificate.',
  purpose: 'To check if the Charge Point registers a security event for invalid certificate.',
  tls: true,
  stationConfig: { securityProfile: 3, vendorName: 'OCTT' },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(securityHandler());

    await setCpoName(ctx, steps);
    const csr = await triggerCertificateRenewal(ctx, steps);
    if (csr == null) return result(steps);

    // An invalid certificate: issued for the CSR by a CA the Charge Point does not trust.
    const untrusted = await createRootCertificate('OCTT Untrusted CA');
    const invalid = await signCertificateRequest(csr, untrusted);
    const certSigned = await ctx.server.sendCommand('CertificateSigned', {
      certificateChain: invalid.chainPem,
    });
    step(
      steps,
      6,
      'CertificateSigned.conf with an invalid certificate is Rejected',
      certSigned['status'] === 'Rejected',
      'status = Rejected',
      `status = ${String(certSigned['status'])}`,
    );

    const event = await waitFor(ctx.server, 'SecurityEventNotification', 15_000);
    step(
      steps,
      7,
      'SecurityEventNotification.req type is InvalidChargePointCertificate',
      event?.['type'] === 'InvalidChargePointCertificate',
      'type = InvalidChargePointCertificate',
      event == null ? 'no SecurityEventNotification.req' : `type = ${String(event['type'])}`,
    );
    return result(steps);
  },
};

export const TC_078_CS: CsTestCase = {
  id: 'TC_078_CS',
  name: 'Invalid CentralSystemCertificate Security Event',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point notifies the Central System of an invalid certificate.',
  purpose: 'To check if the Charge Point registers a security event for invalid CS certificate.',
  tls: true,
  stationConfig: { securityProfile: 2 },
  // Five reconnect cycles with the station's reconnect back-off.
  timeoutMs: 300_000,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const tls = ctx.tls;
    if (tls == null) throw new Error('TC_078_CS needs the TLS test server');
    ctx.server.setMessageHandler(securityHandler());
    const valid = { cert: `${tls.server.pem}\n${tls.root.pem}`, key: tls.server.keyPem };

    // Steps 1-3: abort the connection and measure how long the Charge Point takes to reconnect.
    const abortedAt = Date.now();
    ctx.server.disconnectStation();
    const first = await ctx.server.waitForTlsHandshake(60_000).catch(() => null);
    const reconnectMs = first != null ? first.at - abortedAt : 0;
    await ctx.server.waitForConnection(10_000).catch(() => undefined);
    if (
      !step(
        steps,
        3,
        'Charge Point reconnects with the configured valid server certificate',
        first?.ok === true && ctx.server.isConnected,
        'TLS handshake succeeds',
        first == null
          ? 'no reconnect within 60s'
          : `handshake ok = ${String(first.ok)} after ${String(reconnectMs)}ms`,
      )
    ) {
      return result(steps);
    }

    for (const invalid of await invalidServerCertificates(tls.root)) {
      // Steps 4-7: serve the invalid certificate; the Charge Point must refuse it.
      ctx.server.setServerCertificate(
        `${invalid.cert.pem}\n${invalid.cert.issuer?.pem ?? ''}`,
        invalid.cert.keyPem,
      );
      ctx.server.disconnectStation();
      // The test server sees the refused handshake; without it, wait at most
      // two times the measured reconnection time (but long enough for the back-off).
      const refused = await ctx.server
        .waitForTlsHandshake(Math.max(2 * reconnectMs, 45_000))
        .catch(() => null);
      step(
        steps,
        7,
        `${invalid.name}: Charge Point deems the server certificate invalid and terminates the connection`,
        refused != null && !refused.ok,
        'TLS handshake refused by the Charge Point',
        refused == null
          ? 'no connection attempt seen'
          : refused.ok
            ? 'Charge Point accepted the invalid certificate'
            : `refused (${refused.error ?? 'handshake failed'})`,
      );

      // Steps 8-11: back to the valid certificate; the Charge Point reports the event.
      ctx.server.setServerCertificate(valid.cert, valid.key);
      if (refused?.ok === true) {
        await ctx.server.waitForConnection(10_000).catch(() => undefined);
        continue;
      }
      const event = await waitFor(ctx.server, 'SecurityEventNotification', 60_000);
      step(
        steps,
        10,
        `${invalid.name}: SecurityEventNotification.req type is InvalidCentralSystemCertificate`,
        event?.['type'] === 'InvalidCentralSystemCertificate',
        'type = InvalidCentralSystemCertificate',
        event == null ? 'no SecurityEventNotification.req' : `type = ${String(event['type'])}`,
      );
    }
    return result(steps);
  },
};

export const TC_079_CS: CsTestCase = {
  id: 'TC_079_CS',
  name: 'Get Security Log',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point uploads a security log to a specified location.',
  purpose: 'To check whether the Charge Point can upload its security log.',
  stationConfig: { securityProfile: 1 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(securityHandler());
    const requestId = Math.floor(Math.random() * 1_000_000) + 1;

    const resp = await ctx.server.sendCommand('GetLog', {
      logType: 'SecurityLog',
      requestId,
      log: { remoteLocation: 'https://logs.example.com/upload' },
    });
    step(
      steps,
      2,
      'GetLog.conf is Accepted',
      resp['status'] === 'Accepted',
      'status = Accepted',
      `status = ${String(resp['status'])}`,
    );

    const uploading = await waitFor(ctx.server, 'LogStatusNotification', 10_000);
    step(
      steps,
      3,
      'LogStatusNotification.req Uploading with the GetLog requestId',
      uploading?.['status'] === 'Uploading' && uploading['requestId'] === requestId,
      `status = Uploading, requestId = ${String(requestId)}`,
      uploading == null
        ? 'no LogStatusNotification.req'
        : `status = ${String(uploading['status'])}, requestId = ${String(uploading['requestId'])}`,
    );

    const uploaded = await waitFor(ctx.server, 'LogStatusNotification', 10_000);
    step(
      steps,
      5,
      'LogStatusNotification.req Uploaded with the GetLog requestId',
      uploaded?.['status'] === 'Uploaded' && uploaded['requestId'] === requestId,
      `status = Uploaded, requestId = ${String(requestId)}`,
      uploaded == null
        ? 'no LogStatusNotification.req'
        : `status = ${String(uploaded['status'])}, requestId = ${String(uploaded['requestId'])}`,
    );
    return result(steps);
  },
};

// Prerequisites of TC_080/TC_081: a firmware on a server, signed with a firmware
// signing certificate that chains to the Charge Point's ManufacturerRootCertificate.
async function prepareSignedFirmware(
  ctx: CsTestContext,
  steps: StepResult[],
): Promise<{ firmware: Buffer; signer: TestCertificate; server: FileServer } | null> {
  const manufacturerRoot = await createRootCertificate('OCTT Manufacturer Root CA');
  const signer = await issueCertificate({
    subject: 'CN=OCTT Firmware Signing,O=OCTT,C=US',
    issuer: manufacturerRoot,
    extendedKeyUsages: ['1.3.6.1.5.5.7.3.3'],
  });
  const install = await ctx.server.sendCommand('InstallCertificate', {
    certificateType: 'ManufacturerRootCertificate',
    certificate: manufacturerRoot.pem,
  });
  if (
    !step(
      steps,
      0,
      'Prerequisite: the ManufacturerRootCertificate of the firmware signer is installed',
      install['status'] === 'Accepted',
      'InstallCertificate status = Accepted',
      `status = ${String(install['status'])}`,
    )
  ) {
    return null;
  }
  const firmware = crypto.randomBytes(64 * 1024);
  const server = await startFileServer('/firmware/octt-firmware.bin', firmware);
  return { firmware, signer, server };
}

async function firmwareStatus(
  ctx: CsTestContext,
  steps: StepResult[],
  n: number,
  expected: string,
): Promise<boolean> {
  const msg = await waitFor(ctx.server, 'SignedFirmwareStatusNotification', 20_000);
  return step(
    steps,
    n,
    `SignedFirmwareStatusNotification.req status is ${expected}`,
    msg?.['status'] === expected,
    `status = ${expected}`,
    msg == null ? 'no SignedFirmwareStatusNotification.req' : `status = ${String(msg['status'])}`,
  );
}

export const TC_080_CS: CsTestCase = {
  id: 'TC_080_CS',
  name: 'Secure Firmware Update',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The firmware of a Charge Point is updated in a secure way.',
  purpose: 'To check whether the Charge Point can update its firmware in a secure way.',
  stationConfig: { securityProfile: 1 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(securityHandler());
    const prepared = await prepareSignedFirmware(ctx, steps);
    if (prepared == null) return result(steps);
    try {
      const resp = await ctx.server.sendCommand('SignedUpdateFirmware', {
        requestId: Math.floor(Math.random() * 1_000_000) + 1,
        firmware: {
          location: prepared.server.url,
          retrieveDateTime: new Date().toISOString(),
          signingCertificate: prepared.signer.pem,
          signature: signData(prepared.firmware, prepared.signer),
        },
      });
      step(
        steps,
        2,
        'SignedUpdateFirmware.conf is Accepted',
        resp['status'] === 'Accepted',
        'status = Accepted',
        `status = ${String(resp['status'])}`,
      );
      if (!(await firmwareStatus(ctx, steps, 3, 'Downloading'))) return result(steps);
      if (!(await firmwareStatus(ctx, steps, 5, 'Downloaded'))) return result(steps);
      step(
        steps,
        5,
        'The Charge Point downloaded the firmware from the configured location',
        prepared.server.downloads() > 0,
        'firmware fetched from firmware.location',
        `${String(prepared.server.downloads())} download(s)`,
      );
      if (!(await firmwareStatus(ctx, steps, 7, 'SignatureVerified'))) return result(steps);
      if (!(await firmwareStatus(ctx, steps, 9, 'Installing'))) return result(steps);

      // Steps 11 / 13 / 15 / 17 can arrive in any order.
      const boot = await waitFor(ctx.server, 'BootNotification', 20_000);
      step(
        steps,
        11,
        'Charge Point sends BootNotification.req (answered Accepted, step 12)',
        boot != null,
        'BootNotification.req',
        boot == null ? 'no BootNotification.req' : 'received',
      );
      const statuses = new Map<number, string>();
      for (let i = 0; i < 4 && statuses.size < 2; i++) {
        const sn = await waitFor(ctx.server, 'StatusNotification', 10_000);
        if (sn == null) break;
        statuses.set(sn['connectorId'] as number, sn['status'] as string);
      }
      step(
        steps,
        15,
        'StatusNotification.req Available for connector 0 and connector 1',
        statuses.get(0) === 'Available' && statuses.get(1) === 'Available',
        'connector 0 = Available, connector 1 = Available',
        [...statuses].map(([c, s]) => `connector ${String(c)} = ${s}`).join(', ') || 'none',
      );
      await firmwareStatus(ctx, steps, 17, 'Installed');
      return result(steps);
    } finally {
      await prepared.server.close();
    }
  },
};

export const TC_081_CS: CsTestCase = {
  id: 'TC_081_CS',
  name: 'Secure Firmware Update - Invalid Signature',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Charge Point validates the Signature and deems it invalid.',
  purpose: 'To check whether the Charge Point validates the signature.',
  stationConfig: { securityProfile: 1 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(securityHandler());
    const prepared = await prepareSignedFirmware(ctx, steps);
    if (prepared == null) return result(steps);
    try {
      // An invalid signature: made over different data.
      const invalidSignature = signData(crypto.randomBytes(1024), prepared.signer);
      const resp = await ctx.server.sendCommand('SignedUpdateFirmware', {
        requestId: Math.floor(Math.random() * 1_000_000) + 1,
        firmware: {
          location: prepared.server.url,
          retrieveDateTime: new Date().toISOString(),
          signingCertificate: prepared.signer.pem,
          signature: invalidSignature,
        },
      });
      step(
        steps,
        2,
        'SignedUpdateFirmware.conf is Accepted',
        resp['status'] === 'Accepted',
        'status = Accepted',
        `status = ${String(resp['status'])}`,
      );
      if (!(await firmwareStatus(ctx, steps, 3, 'Downloading'))) return result(steps);
      if (!(await firmwareStatus(ctx, steps, 5, 'Downloaded'))) return result(steps);
      // Steps 7 through 10 can be sent in any order.
      await firmwareStatus(ctx, steps, 7, 'InvalidSignature');
      const event = await waitFor(ctx.server, 'SecurityEventNotification', 10_000);
      step(
        steps,
        9,
        'SecurityEventNotification.req type is InvalidFirmwareSignature',
        event?.['type'] === 'InvalidFirmwareSignature',
        'type = InvalidFirmwareSignature',
        event == null ? 'no SecurityEventNotification.req' : `type = ${String(event['type'])}`,
      );
      return result(steps);
    } finally {
      await prepared.server.close();
    }
  },
};

// Reusable State "The Charge Point is triggered to reset": Reset.req Hard, then
// Station-initiated messages with the time the Test System received them, so
// a test can tell the messages of the new connection from those of the old one.
interface ReceivedMessage {
  action: string;
  payload: Record<string, unknown>;
  at: number;
}

function recordingHandler(
  log: ReceivedMessage[],
): (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const answer = securityHandler();
  return (action, payload) => {
    log.push({ action, payload, at: Date.now() });
    return answer(action);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Reusable State "The Charge Point is triggered to reset": Reset.req Hard, then
// the Charge Point reboots and connects again. Returns the new upgrade request.
async function resetAndReconnect(
  ctx: CsTestContext,
  steps: StepResult[],
  n: number,
): Promise<UpgradeAttempt | null> {
  const before = ctx.server.upgradeAttempts.length;
  const reset = await ctx.server.sendCommand('Reset', { type: 'Hard' });
  step(
    steps,
    n,
    'Reset.conf (Hard) is Accepted',
    reset['status'] === 'Accepted',
    'status = Accepted',
    `status = ${String(reset['status'])}`,
  );
  const deadline = Date.now() + 30_000;
  while (ctx.server.upgradeAttempts.length === before && Date.now() < deadline) await sleep(50);
  const upgrade = ctx.server.upgradeAttempts[before] ?? null;
  if (upgrade != null) await ctx.server.waitForConnection(10_000).catch(() => undefined);
  return upgrade;
}

// BootNotification on the new connection, then StatusNotification for connector 0
// and connector 1 (messages received after `since`).
async function bootAndStatus(
  log: readonly ReceivedMessage[],
  since: number,
  steps: StepResult[],
  bootStep: number,
  statusStep: number,
  requireAvailable: boolean,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  const after = (): ReceivedMessage[] => log.filter((m) => m.at >= since);
  let boot = after().find((m) => m.action === 'BootNotification');
  while (boot == null && Date.now() < deadline) {
    await sleep(100);
    boot = after().find((m) => m.action === 'BootNotification');
  }
  step(
    steps,
    bootStep,
    'Charge Point sends BootNotification.req (answered Accepted)',
    boot != null,
    'BootNotification.req',
    boot == null ? 'no BootNotification.req on the new connection' : 'received',
  );
  const statuses = new Map<number, string>();
  while (Date.now() < deadline && boot != null) {
    statuses.clear();
    for (const m of after()) {
      if (m.action === 'StatusNotification' && m.at >= boot.at) {
        statuses.set(m.payload['connectorId'] as number, m.payload['status'] as string);
      }
    }
    if (statuses.has(0) && statuses.has(1)) break;
    await sleep(100);
  }
  const ok =
    statuses.has(0) &&
    statuses.has(1) &&
    (!requireAvailable || (statuses.get(0) === 'Available' && statuses.get(1) === 'Available'));
  step(
    steps,
    statusStep,
    `StatusNotification.req for connector 0 and connector 1${requireAvailable ? ' with status Available' : ''}`,
    ok,
    requireAvailable
      ? 'connector 0 = Available, connector 1 = Available'
      : 'connector 0 and 1 reported',
    [...statuses].map(([c, st]) => `connector ${String(c)} = ${st}`).join(', ') || 'none',
  );
}

// Basic Auth header: Basic <base64(<ChargePointId>:<password>)>, ChargePointId = URL suffix.
function checkBasicAuth(
  steps: StepResult[],
  n: number,
  upgrade: UpgradeAttempt,
  stationId: string,
  password: string,
): void {
  const urlId = decodeURIComponent(upgrade.url.replace(/^\//, '').split('?')[0] ?? '');
  const header = upgrade.authorization ?? '';
  const decoded = header.startsWith('Basic ')
    ? Buffer.from(header.slice(6), 'base64').toString('utf8')
    : '';
  const separator = decoded.indexOf(':');
  const user = separator === -1 ? '' : decoded.slice(0, separator);
  const pass = separator === -1 ? '' : decoded.slice(separator + 1);
  step(
    steps,
    n,
    'HTTP upgrade AUTHORIZATION is Basic <Base64(<ChargePointId>:<BasicAuthPassword>)>',
    user === urlId &&
      urlId === stationId &&
      pass === password &&
      pass.length >= 16 &&
      pass.length <= 40,
    `user = ${stationId} (URL suffix), password = configured password (16-40 characters)`,
    header === ''
      ? 'no AUTHORIZATION header'
      : `user = ${user}, URL suffix = ${urlId}, password ${pass === password ? 'matches' : 'differs'} (${String(pass.length)} characters)`,
  );
}

const TLS12_OR_ABOVE = new Set(['TLSv1.2', 'TLSv1.3']);

// TLS checks of TC_086/TC_087 (Step 2 / Step 4): TLS 1.2 or above, and the
// ClientHello offers (TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 AND
// TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384) OR (TLS_RSA_WITH_AES_128_GCM_SHA256 AND
// TLS_RSA_WITH_AES_256_GCM_SHA384).
function checkTlsVersionAndSuites(steps: StepResult[], n: number, upgrade: UpgradeAttempt): void {
  step(
    steps,
    n,
    'The Charge Point uses TLS 1.2 or above',
    upgrade.tls != null && TLS12_OR_ABOVE.has(upgrade.tls.protocol ?? ''),
    'TLSv1.2 or TLSv1.3',
    `protocol = ${String(upgrade.tls?.protocol)}`,
  );
  const offered = upgrade.tls?.offeredCipherSuites ?? [];
  const ecdsa =
    offered.includes(TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256) &&
    offered.includes(TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384);
  const rsa =
    offered.includes(TLS_RSA_WITH_AES_128_GCM_SHA256) &&
    offered.includes(TLS_RSA_WITH_AES_256_GCM_SHA384);
  step(
    steps,
    n,
    'The ClientHello offers both ECDHE-ECDSA AES-GCM suites or both RSA AES-GCM suites',
    ecdsa || rsa,
    '(0xC02B and 0xC02C) or (0x009C and 0x009D)',
    `ECDHE-ECDSA pair ${ecdsa ? 'offered' : 'missing'}, RSA pair ${rsa ? 'offered' : 'missing'} (${String(offered.length)} suites)`,
  );
}

const EC_CURVE_BITS: Record<string, number> = {
  prime256v1: 256,
  secp224r1: 224,
  secp384r1: 384,
  secp521r1: 521,
};

export const TC_083_CS: CsTestCase = {
  id: 'TC_083_CS',
  name: 'Upgrade security profile',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Central System upgrades the connection to a higher Security Profile with the SecurityProfile configuration key.',
  purpose: 'To check if the Charge Point is able to upgrade the Security Profile.',
  // Connected with Security Profile 2; steps 15-18 apply only to an upgrade from 1 to 2.
  tls: true,
  stationConfig: { securityProfile: 2, vendorName: 'OCTT' },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const tls = ctx.tls;
    if (tls == null) throw new Error('TC_083_CS needs the TLS test server');
    const log: ReceivedMessage[] = [];
    ctx.server.setMessageHandler(recordingHandler(log));

    // Memory State RenewChargePointCertificate (Security Profile 2).
    await setCpoName(ctx, steps);
    const csr = await triggerCertificateRenewal(ctx, steps);
    if (csr == null) return result(steps);
    const signed = await signCertificateRequest(csr, tls.root);
    const certSigned = await ctx.server.sendCommand('CertificateSigned', {
      certificateChain: signed.chainPem,
    });
    if (
      !step(
        steps,
        0,
        'Before (RenewChargePointCertificate): CertificateSigned.conf is Accepted',
        certSigned['status'] === 'Accepted',
        'status = Accepted',
        `status = ${String(certSigned['status'])}`,
      )
    ) {
      return result(steps);
    }

    const change = await ctx.server.sendCommand('ChangeConfiguration', {
      key: 'SecurityProfile',
      value: '3',
    });
    step(
      steps,
      2,
      'ChangeConfiguration.conf SecurityProfile = 3 is Accepted or RebootRequired',
      change['status'] === 'Accepted' || change['status'] === 'RebootRequired',
      'status = Accepted or RebootRequired',
      `status = ${String(change['status'])}`,
    );

    const upgrade = await resetAndReconnect(ctx, steps, 4);
    const renewed = Buffer.from(signed.leaf.rawData);
    step(
      steps,
      5,
      'The Charge Point reconnects with Security Profile 3 (client certificate from the renewal)',
      upgrade?.tls?.clientCertificate?.raw.equals(renewed) === true,
      'TLS client certificate = renewed ChargePointCertificate',
      upgrade == null
        ? 'no reconnection'
        : upgrade.tls?.clientCertificate == null
          ? 'no client certificate'
          : upgrade.tls.clientCertificate.raw.equals(renewed)
            ? 'renewed certificate presented'
            : 'other client certificate',
    );
    await bootAndStatus(log, upgrade?.at ?? Date.now(), steps, 5, 7, true);
    return result(steps);
  },
};

export const TC_084_CS: CsTestCase = {
  id: 'TC_084_CS',
  name: 'Downgrade security profile - Rejected',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'It is not possible to downgrade to a lower Security Profile.',
  purpose: 'To check if the Charge Point rejects downgrading the Security Profile.',
  tls: true,
  stationConfig: { securityProfile: 2 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(securityHandler());
    const change = await ctx.server.sendCommand('ChangeConfiguration', {
      key: 'SecurityProfile',
      value: '1',
    });
    step(
      steps,
      2,
      'ChangeConfiguration.conf SecurityProfile = 1 (one level lower) is Rejected',
      change['status'] === 'Rejected',
      'status = Rejected',
      `status = ${String(change['status'])}`,
    );
    return result(steps);
  },
};

export const TC_085_CS: CsTestCase = {
  id: 'TC_085_CS',
  name: 'Basic Authentication - Valid username/password combination',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Charge Point uses Basic authentication to authenticate itself to the Central System, when using security profile 1 or 2.',
  purpose:
    'To verify whether the Charge Point is able to authenticate itself to the Central System using Basic Authentication.',
  stationConfig: { securityProfile: 1 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const log: ReceivedMessage[] = [];
    ctx.server.setMessageHandler(recordingHandler(log));
    const upgrade = await resetAndReconnect(ctx, steps, 0);
    const connected = step(
      steps,
      2,
      'The Central System upgrades the connection to a WebSocket connection',
      upgrade != null && ctx.server.isConnected,
      'WebSocket connection after the reset',
      upgrade == null ? 'no HTTP upgrade request within 30s' : 'connected',
    );
    if (!connected || upgrade == null) return result(steps);
    checkBasicAuth(steps, 1, upgrade, ctx.stationId, ctx.security.password);
    await bootAndStatus(log, upgrade?.at ?? Date.now(), steps, 3, 5, false);
    return result(steps);
  },
};

export const TC_086_CS: CsTestCase = {
  id: 'TC_086_CS',
  name: 'TLS - server-side certificate - Valid certificate',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Central System uses a server-side certificate to identify itself to the Charge Point, when using security profile 2 or 3.',
  purpose:
    'To verify whether the Charge Point is able to receive a server certificate provided by the Central System and setup a secured WebSocket connection.',
  tls: true,
  stationConfig: { securityProfile: 2 },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const log: ReceivedMessage[] = [];
    ctx.server.setMessageHandler(recordingHandler(log));
    const upgrade = await resetAndReconnect(ctx, steps, 0);
    const connected = step(
      steps,
      6,
      'The Charge Point accepts the server certificate and upgrades to a secured WebSocket',
      upgrade?.tls != null && ctx.server.isConnected,
      'wss:// connection after the reset',
      upgrade == null ? 'no HTTP upgrade request within 30s' : 'connected',
    );
    if (!connected || upgrade == null) return result(steps);
    checkBasicAuth(steps, 5, upgrade, ctx.stationId, ctx.security.password);
    await bootAndStatus(log, upgrade?.at ?? Date.now(), steps, 7, 9, false);
    checkTlsVersionAndSuites(steps, 2, upgrade);
    return result(steps);
  },
};

export const TC_087_CS: CsTestCase = {
  id: 'TC_087_CS',
  name: 'TLS - Client-side certificate - valid certificate',
  module: '25-security',
  version: 'ocpp1.6',
  sut: 'cs',
  description:
    'The Charge Point uses a client-side certificate to identify itself to the Central System, when using security profile 3.',
  purpose:
    'To verify whether the Charge Point is able to provide a valid client certificate and setup a secured WebSocket connection.',
  tls: true,
  stationConfig: { securityProfile: 3, serialNumber: 'OCTT-SN-087' },
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const log: ReceivedMessage[] = [];
    ctx.server.setMessageHandler(recordingHandler(log));
    const upgrade = await resetAndReconnect(ctx, steps, 0);
    const connected = step(
      steps,
      6,
      'The Charge Point sets up a secured WebSocket connection',
      upgrade?.tls != null && ctx.server.isConnected,
      'wss:// connection after the reset',
      upgrade == null ? 'no HTTP upgrade request within 30s' : 'connected',
    );
    if (!connected || upgrade == null) return result(steps);

    const cert = upgrade.tls?.clientCertificate ?? null;
    const keyType = cert?.publicKey.asymmetricKeyType;
    const details = cert?.publicKey.asymmetricKeyDetails;
    const keyBits =
      keyType === 'ec'
        ? (EC_CURVE_BITS[details?.namedCurve ?? ''] ?? 0)
        : (details?.modulusLength ?? 0);
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert?.subject ?? '')?.[1];
    step(
      steps,
      4,
      'Client certificate is X.509 with a serial number and CN = Charge Point serial number',
      cert != null && cert.serialNumber !== '' && cn === ctx.security.serialNumber,
      `X.509 client certificate, serial number present, CN = ${ctx.security.serialNumber}`,
      cert == null
        ? 'no parsable client certificate'
        : `serial = ${cert.serialNumber}, CN = ${String(cn)}`,
    );
    step(
      steps,
      4,
      'Client key is at least 224 bits (EC) or 2048 bits (RSA/DSA)',
      keyType === 'ec' ? keyBits >= 224 : keyBits >= 2048,
      'EC >= 224 bits, RSA/DSA >= 2048 bits',
      `${String(keyType)} ${String(keyBits)} bits`,
    );
    await bootAndStatus(log, upgrade?.at ?? Date.now(), steps, 7, 9, false);
    checkTlsVersionAndSuites(steps, 4, upgrade);
    return result(steps);
  },
};
