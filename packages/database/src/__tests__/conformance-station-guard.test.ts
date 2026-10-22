// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Conformance test stations never appear or count where operators and
 * drivers look (lib/conformance-stations.ts). Every server source file that
 * queries charging stations either applies one of the conformance helpers or
 * is listed below as one that only reads or writes stations by id (lookups,
 * OCPP message handling, per-station commands and protocol crons). A new file
 * that queries stations fails here until it uses a helper or joins the list.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES = resolve(import.meta.dirname, '../../..');

const SCANNED = [
  'api/src',
  'services/src',
  'worker/src',
  'ocpi/src',
  'database/src/lib',
  'ocpp/src/services',
];

const STATION_QUERY = /\bchargingStations\b|\bcharging_stations\b/;

// The helpers, and the shared queries built on them (public portal stations,
// payment and revenue scopes).
const HELPER =
  /\b(?:isOperatorStation|inOperatorStation|operatorStationSql|operatorStationIdSql|publicStationListed|paymentRecordsOfOperatorStations|sessionItemsSql|revenueItemsSql)\b/;

/** Files that only touch stations by id, or define the helpers. */
const BY_ID_ONLY = new Set([
  'api/src/lib/charging-profile-id.ts',
  'api/src/lib/command-station.ts',
  'api/src/lib/css-pairing.ts',
  'api/src/lib/fleet-operation-scope.ts',
  'api/src/lib/ocpi-site-scope.ts',
  'api/src/lib/pricing-events.ts',
  'api/src/lib/remote-start-timeout.ts',
  'api/src/lib/session-site-scope.ts',
  'api/src/lib/site-access.ts',
  'api/src/lib/station-circuit.ts',
  'api/src/lib/station-command-audit.ts',
  'api/src/lib/station-message-log.ts',
  'api/src/lib/support-case-scope.ts',
  'api/src/routes/ai-insights.ts',
  'api/src/routes/audit.ts',
  'api/src/routes/display-messages.ts',
  'api/src/routes/fleet-reservations.ts',
  'api/src/routes/fleets.ts',
  'api/src/routes/local-auth-list.ts',
  'api/src/routes/ocpp-commands.ts',
  'api/src/routes/portal/support-cases.ts',
  'api/src/routes/reports.ts',
  'api/src/routes/station-sim.ts',
  'api/src/routes/support-cases.ts',
  'api/src/services/ad-hoc-payment.service.ts',
  'api/src/services/ai/engine/explain-context.ts',
  'api/src/services/free-vend.service.ts',
  'api/src/services/session-rebill.service.ts',
  'api/src/services/station-ai-insights.service.ts',
  'api/src/services/station-evse-retire.service.ts',
  'api/src/services/station-onboarding.service.ts',
  'api/src/services/station-security.service.ts',
  'api/src/services/station-simulator.service.ts',
  'api/src/services/station.service.ts',
  'api/src/services/token.service.ts',
  'api/src/services/web-payment.service.ts',
  'database/src/lib/autocharge.ts',
  'database/src/lib/firmware-updates.ts',
  'database/src/lib/fixture-stations.ts',
  'database/src/lib/fleet-credit-limit.ts',
  'database/src/lib/free-vend-setting.ts',
  'database/src/lib/load-management-state.ts',
  'database/src/lib/ocpp-session-tariff.ts',
  'database/src/lib/remote-start-timeout.ts',
  'database/src/lib/reservation-fee-terms.ts',
  'database/src/lib/session-fee-floor.ts',
  'database/src/lib/session-site.ts',
  'database/src/lib/station-offline.ts',
  'database/src/lib/station-status.ts',
  'database/src/lib/station-watch.ts',
  'database/src/lib/tariff-resolution.ts',
  'ocpi/src/routes/cpo/commands.ts',
  'services/src/ai-evidence/authorization.ts',
  'services/src/ai-evidence/concurrent-session.ts',
  'services/src/ai-evidence/driver.ts',
  'services/src/ai-evidence/reservation.ts',
  'services/src/ai-evidence/session.ts',
  'services/src/ai-evidence/state.ts',
  'services/src/ai-evidence/station.ts',
  'services/src/fleet-invoice.service.ts',
  'services/src/maintenance-check.ts',
  'services/src/reservation-expiry.ts',
  'services/src/reservation.service.ts',
  'services/src/station-derived-status.ts',
  'services/src/station-sim.service.ts',
  'services/src/support-case-notify.ts',
  'worker/src/driver-ai/analyze.ts',
  'worker/src/handlers/certificate-expiration-check.ts',
  'worker/src/handlers/offline-command-cleanup.ts',
  'worker/src/handlers/reservation-activate.ts',
  'worker/src/handlers/reservation-expiry-check.ts',
  'worker/src/handlers/stale-session-cleanup.ts',
  'worker/src/handlers/station-message-charging-refresh.ts',
  'worker/src/handlers/station-watch-dispatch.ts',
  'worker/src/handlers/tariff-boundary-check.ts',
  'worker/src/redis-recovery.ts',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (
      name === 'node_modules' ||
      name === 'dist' ||
      name === 'generated' ||
      name.startsWith('__')
    ) {
      return [];
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

const files = SCANNED.flatMap((dir) => sourceFiles(join(PACKAGES, dir)))
  .map((path) => ({ path: relative(PACKAGES, path), text: readFileSync(path, 'utf8') }))
  .filter((file) => STATION_QUERY.test(file.text));

describe('conformance station exclusion guard', () => {
  it('scans the server sources that query stations', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('every station query applies a conformance helper or reads by id only', () => {
    const missing = files
      .filter((file) => !HELPER.test(file.text) && !BY_ID_ONLY.has(file.path))
      .map((file) => file.path);
    expect(missing).toEqual([]);
  });

  it('lists no file that now uses a helper or no longer exists', () => {
    const known = new Map(files.map((file) => [file.path, file.text]));
    const stale = [...BY_ID_ONLY].filter((path) => {
      const text = known.get(path);
      return text == null || HELPER.test(text);
    });
    expect(stale).toEqual([]);
  });

  it('never matches the conformance id prefix outside the helper file and the runners', () => {
    const prefix = files.filter((file) => /LIKE\s+'OCTT-/.test(file.text)).map((file) => file.path);
    expect(prefix).toEqual([]);
  });
});
