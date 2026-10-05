// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';
import { isPasswordString } from '../../../../security-test-helpers.js';
import { invalidServerCertificates } from '../../../../cs-security-pki.js';
import {
  basicAuthHeader,
  connectorAvailableSteps,
  keyStrengthOk,
  result,
  step,
  testPki,
  tlsHandshakeSteps,
  validServerTls,
  waitForSecurityEvent,
  waitForUpgrade,
  waitUntil,
} from './helpers.js';

/** Manual Action: power on the station. A first connection that fails is retried by the station. */
function powerOn(ctx: Parameters<CsTestCase['execute']>[0]): void {
  void ctx.station.start().catch((err: unknown) => {
    ctx.logger.debug(
      { error: err instanceof Error ? err.message : String(err) },
      'First connection failed; the station retries',
    );
  });
}

/**
 * TC_A_01_CS: Basic Authentication - Valid username/password combination
 *
 * The Charging Station uses Basic authentication to authenticate itself to the CSMS
 * when using security profile 1 or 2.
 */
export const TC_A_01_CS: CsTestCase = {
  id: 'TC_A_01_CS',
  name: 'Basic Authentication - Valid username/password combination',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station uses Basic authentication to authenticate itself to the CSMS, when using security profile 1 and/or 2.',
  purpose:
    'To verify whether the Charging Station is able to authenticate itself to the CSMS using Basic Authentication.',
  stationConfig: { securityProfile: 1 },
  // Reusable State Booted (Manual Action: power cycle): the test powers the station on.
  skipAutoBoot: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const { password } = ctx.security;

    // Step 1: Reusable State Booted
    powerOn(ctx);
    const upgrade = await waitForUpgrade(ctx.server, 0, 15_000);
    const boot = await ctx.server.waitForMessage('BootNotification', 15_000);
    steps.push(
      step(
        1,
        'Charging Station sends BootNotificationRequest (Reusable State Booted)',
        boot['reason'] != null,
        'BootNotificationRequest received',
        `reason = ${String(boot['reason'])}`,
      ),
    );
    steps.push(...(await connectorAvailableSteps(ctx.server, 1)));

    // Tool validation step 1: AUTHORIZATION: Basic <Base64(<ChargingStationId>:<password>)>
    const urlStationId = (upgrade?.url ?? '').replace(/^\//, '').split('?')[0] ?? '';
    steps.push(
      step(
        1,
        'Authorization header is Basic Base64(<ChargingStationId>:<Configured basicAuthPassword>)',
        upgrade?.authorization === basicAuthHeader(ctx.stationId, password),
        `Basic Base64(${ctx.stationId}:<configured password>)`,
        upgrade?.authorization ?? 'no Authorization header',
      ),
      step(
        1,
        'Username equals the ChargingStationId at the end of the connection URL',
        decodeURIComponent(urlStationId) === ctx.stationId,
        ctx.stationId,
        urlStationId,
      ),
      step(
        1,
        'BasicAuthPassword has 16 to 40 passwordString characters',
        password.length >= 16 && password.length <= 40 && isPasswordString(password),
        '16-40 characters of passwordString',
        `${String(password.length)} characters, passwordString: ${String(isPasswordString(password))}`,
      ),
    );

    const startup = await waitForSecurityEvent(
      ctx.server,
      ['StartupOfTheDevice', 'ResetOrReboot'],
      10_000,
    );
    steps.push(
      step(
        1,
        'SecurityEventNotificationRequest after boot',
        startup != null,
        'type StartupOfTheDevice or ResetOrReboot',
        startup != null ? `type = ${String(startup['type'])}` : 'not received',
      ),
    );

    return result(steps);
  },
};

/**
 * TC_A_04_CS: TLS - server-side certificate - Valid certificate
 *
 * The CSMS uses a server-side certificate to identify itself to the Charging Station
 * when using security profile 2 or 3.
 */
export const TC_A_04_CS: CsTestCase = {
  id: 'TC_A_04_CS',
  name: 'TLS - server-side certificate - Valid certificate',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS uses a server-side certificate to identify itself to the Charging Station, when using security profile 2 and/or 3.',
  purpose:
    'To verify whether the Charging Station is able to receive a server certificate provided by the CSMS and establish a secured connection.',
  stationConfig: { securityProfile: 2 },
  tls: true,
  // Reusable State Booting: the connection is not set up yet.
  skipAutoBoot: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Steps 1-6: TLS handshake with the configured server certificate, HTTP upgrade
    powerOn(ctx);
    const upgrade = await waitForUpgrade(ctx.server, 0, 15_000);
    steps.push(...tlsHandshakeSteps(2, upgrade?.tls ?? null));
    steps.push(
      step(
        5,
        'HTTP upgrade request carries the username/password (security profile 2)',
        upgrade?.authorization === basicAuthHeader(ctx.stationId, ctx.security.password),
        'Basic Base64(<ChargingStationId>:<password>)',
        upgrade?.authorization ?? 'no Authorization header',
      ),
    );

    // Steps 7-8: BootNotification, answered Accepted
    const boot = await ctx.server.waitForMessage('BootNotification', 15_000);
    steps.push(
      step(
        7,
        'Charging Station sends BootNotificationRequest over the secured connection',
        boot['chargingStation'] != null,
        'BootNotificationRequest received',
        'received',
      ),
    );

    // Step 9: connector status
    steps.push(...(await connectorAvailableSteps(ctx.server, 9)));
    return result(steps);
  },
};

/**
 * TC_A_05_CS: TLS - server-side certificate - Invalid certificate
 *
 * The Charging Station terminates the connection when the received server certificate
 * is invalid, then reports a SecurityEventNotification.
 */
export const TC_A_05_CS: CsTestCase = {
  id: 'TC_A_05_CS',
  name: 'TLS - server-side certificate - Invalid certificate',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS uses a server-side certificate to identify itself to the Charging Station, when using security profile 2 and/or 3.',
  purpose:
    'To verify whether the Charging Station is able to terminate the connection when the received server certificate is invalid.',
  stationConfig: { securityProfile: 2 },
  tls: true,
  // The Configuration State sets no RetryBackOff* values, so the station keeps the
  // test station's reconnect back-off (CS_TEST_RECONNECT_BACK_OFF in cs-executor.ts:
  // RetryBackOffWaitMinimum W = 10 s, RandomRange R = 5 s, doubled per failed attempt).
  // Per certificate: step 1 reconnect <= W+R, the refused attempt <= W+R, then 2x the measured reconnection time before the valid
  // certificate is back, by which time the attempt after <= 2W+R may have failed too and
  // the next one comes <= 4W+R later: about 85 s typical and 115 s worst case, so five
  // certificates need up to about 575 s.
  timeoutMs: 660_000,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const tls = testPki(ctx);
    const validTls = validServerTls(tls);

    for (const variant of await invalidServerCertificates(tls.root)) {
      // Steps 1-3: abort the connection and measure the reconnection time
      const before = ctx.server.upgradeAttempts.length;
      const abortedAt = Date.now();
      ctx.server.disconnectStation(false);
      const reconnected = await waitForUpgrade(ctx.server, before, 20_000);
      if (reconnected == null) {
        steps.push(
          step(3, `${variant.name}: station reconnects`, false, 'reconnection', 'none in 20 s'),
        );
        break;
      }
      const reconnectMs = reconnected.at - abortedAt;
      await waitUntil(() => ctx.server.isConnected, 5_000);

      // Steps 4-7: abort again and present the invalid certificate
      const handshakesBefore = ctx.server.tlsHandshakes().length;
      const failed = () =>
        ctx.server
          .tlsHandshakes()
          .slice(handshakesBefore)
          .find((h) => !h.ok);
      const upgradesBefore = ctx.server.upgradeAttempts.length;
      ctx.server.setTlsOptions({
        ...validTls,
        cert: `${variant.cert.pem}\n${variant.cert.issuer?.pem ?? ''}`,
        key: variant.cert.keyPem,
      });
      ctx.server.disconnectStation(false);
      const refused = await waitUntil(() => failed() != null, reconnectMs * 3 + 5_000);
      steps.push(
        step(
          7,
          `${variant.name}: station terminates the TLS handshake`,
          refused && ctx.server.upgradeAttempts.length === upgradesBefore,
          'handshake aborted by the station, no HTTP upgrade',
          refused ? `aborted: ${failed()?.error ?? ''}` : 'no failed handshake seen',
        ),
      );

      // Two times the measured reconnection time, then the valid certificate again (step 9)
      await new Promise((r) => setTimeout(r, reconnectMs * 2));
      ctx.server.setTlsOptions(validTls);
      // An attempt between the refusal and the switch fails too and doubles the back-off:
      // the next attempt can come up to 4W + 2R - 2W = 50 s (W = 10 s, R = 5 s) after the
      // switch. The measured reconnection time (about W + R/2) scales that bound.
      const backWaitMs = reconnectMs * 5 + 10_000;
      const back = await waitForUpgrade(ctx.server, upgradesBefore, backWaitMs);
      steps.push(
        step(
          8,
          `${variant.name}: station reconnects with the valid certificate`,
          back != null,
          'reconnection',
          back != null ? 'reconnected' : `none in ${String(Math.round(backWaitMs / 1000))} s`,
        ),
      );

      // Step 10: SecurityEventNotification InvalidCsmsCertificate
      const event = await waitForSecurityEvent(ctx.server, ['InvalidCsmsCertificate'], 15_000);
      steps.push(
        step(
          10,
          `${variant.name}: SecurityEventNotificationRequest type InvalidCsmsCertificate`,
          event != null,
          'type = InvalidCsmsCertificate',
          event != null ? `type = ${String(event['type'])}` : 'not received',
        ),
      );
    }

    return result(steps);
  },
};

/**
 * TC_A_06_CS: TLS - server-side certificate - TLS version too low
 *
 * The Charging Station terminates the connection when the TLS version is lower than 1.2,
 * then reports a SecurityEventNotification.
 */
export const TC_A_06_CS: CsTestCase = {
  id: 'TC_A_06_CS',
  name: 'TLS - server-side certificate - TLS version too low',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS uses a server-side certificate to identify itself to the Charging Station, when using security profile 2 and/or 3.',
  purpose:
    'To verify whether the Charging Station is able to terminate the connection when it notices the used TLS version is lower than 1.2.',
  stationConfig: { securityProfile: 2 },
  tls: true,
  // The scenario starts with the station's first TLS handshake.
  skipAutoBoot: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const validTls = validServerTls(testPki(ctx));

    // Steps 1-3: the Test System answers with a TLS version lower than 1.2
    ctx.server.setTlsOptions({ ...validTls, maxVersion: 'TLSv1.1' });
    powerOn(ctx);
    const failed = () => ctx.server.tlsHandshakes().find((h) => !h.ok);
    const refused = await waitUntil(() => failed() != null, 15_000);
    steps.push(
      step(
        3,
        'Charging Station terminates the connection on TLS lower than 1.2',
        refused && ctx.server.upgradeAttempts.length === 0,
        'handshake aborted, no HTTP upgrade',
        refused ? `aborted: ${failed()?.error ?? ''}` : 'no failed handshake seen',
      ),
    );

    // Steps 4-9: the Test System answers with TLS 1.2 or above
    ctx.server.setTlsOptions(validTls);
    const upgrade = await waitForUpgrade(ctx.server, 0, 30_000);
    steps.push(...tlsHandshakeSteps(5, upgrade?.tls ?? null));

    // Steps 10-13: BootNotification and connector status
    const boot = await ctx.server.waitForMessage('BootNotification', 15_000);
    steps.push(
      step(
        10,
        'Charging Station sends BootNotificationRequest',
        boot['chargingStation'] != null,
        'received',
        'received',
      ),
    );
    steps.push(...(await connectorAvailableSteps(ctx.server, 12)));

    // Steps 14-17 (any order): StartupOfTheDevice/ResetOrReboot, and optionally InvalidTLSVersion
    const events: string[] = [];
    for (;;) {
      const event = await waitForSecurityEvent(
        ctx.server,
        ['StartupOfTheDevice', 'ResetOrReboot', 'InvalidTLSVersion'],
        events.length === 0 ? 10_000 : 3_000,
      );
      if (event == null) break;
      events.push(event['type'] as string);
    }
    steps.push(
      step(
        14,
        'SecurityEventNotificationRequest type StartupOfTheDevice or ResetOrReboot',
        events.includes('StartupOfTheDevice') || events.includes('ResetOrReboot'),
        'StartupOfTheDevice or ResetOrReboot',
        events.join(', ') || 'none',
      ),
    );
    if (events.includes('InvalidTLSVersion')) {
      steps.push(
        step(
          16,
          'SecurityEventNotificationRequest type InvalidTLSVersion (optional)',
          true,
          'InvalidTLSVersion',
          'received',
        ),
      );
    }

    return result(steps);
  },
};

/**
 * TC_A_07_CS: TLS - Client-side certificate - valid certificate
 *
 * The Charging Station uses a client-side certificate to identify itself to the CSMS
 * when using security profile 3.
 */
export const TC_A_07_CS: CsTestCase = {
  id: 'TC_A_07_CS',
  name: 'TLS - Client-side certificate - valid certificate',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station uses a client-side certificate to identify itself to the CSMS, when using security profile 3.',
  purpose:
    'To verify whether the Charging Station is able to provide a valid client certificate and setup a secured connection.',
  stationConfig: { securityProfile: 3 },
  tls: true,
  // Reusable State Booting: the connection is not set up yet.
  skipAutoBoot: true,
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Steps 1-6: mutual TLS handshake and HTTP upgrade
    powerOn(ctx);
    const upgrade = await waitForUpgrade(ctx.server, 0, 15_000);
    const tls = upgrade?.tls ?? null;
    steps.push(...tlsHandshakeSteps(4, tls));

    // Tool validations step 4: the client certificate
    const cert = tls?.clientCertificate ?? null;
    const cn = cert?.subject
      .split('\n')
      .find((part) => part.startsWith('CN='))
      ?.slice(3);
    steps.push(
      step(
        4,
        'Client certificate is sent and issued by the CSMS root certificate (X.509)',
        cert != null && tls?.clientCertificateAuthorized === true,
        'X.509 client certificate that chains to the CSMS root',
        cert == null
          ? 'no client certificate'
          : `authorized: ${String(tls?.clientCertificateAuthorized)} ${tls?.clientCertificateError ?? ''}`,
      ),
      step(
        4,
        'Client certificate key: RSA/DSA at least 2048 bits or EC at least 224 bits',
        cert != null && keyStrengthOk(cert),
        'RSA >= 2048 or EC >= 224',
        cert == null ? 'no client certificate' : String(cert.publicKey.asymmetricKeyType),
      ),
      step(
        4,
        'Client certificate includes a serial number',
        cert != null && cert.serialNumber !== '',
        'serial number present',
        cert?.serialNumber ?? 'no client certificate',
      ),
      step(
        4,
        'Subject commonName is the serial number of the Charging Station',
        cn === ctx.security.serialNumber,
        `CN=${ctx.security.serialNumber}`,
        cn != null ? `CN=${cn}` : 'no commonName',
      ),
    );

    // Steps 7-8: BootNotification
    const boot = await ctx.server.waitForMessage('BootNotification', 15_000);
    steps.push(
      step(
        7,
        'Charging Station sends BootNotificationRequest',
        boot['chargingStation'] != null,
        'received',
        'received',
      ),
    );

    // Step 9: connector status
    steps.push(...(await connectorAvailableSteps(ctx.server, 9)));
    return result(steps);
  },
};
