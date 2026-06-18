// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface CsmsEvent {
  eventType: string;
  stationId: string | null;
  siteId: string | null;
  sessionId: string | null;
  caseId: string | null;
  runId: number | null;
  campaignId?: string | null;
  driverId?: string | null;
  fleetId?: string | null;
  category?: string | null;
}

// Maps an SSE event to the TanStack Query keys to invalidate. Pure so it can be
// unit-tested without the EventSource machinery.
export function getQueryKeysForEvent(event: CsmsEvent): string[][] {
  const keys: string[][] = [];
  const { eventType, stationId, siteId, driverId, fleetId, category } = event;

  switch (eventType) {
    case 'station.status':
      keys.push(['dashboard', 'stats']);
      keys.push(['dashboard', 'station-status']);
      keys.push(['dashboard', 'uptime']);
      keys.push(['dashboard', 'ocpp-health']);
      keys.push(['stations']);
      if (stationId != null) {
        keys.push(['stations', stationId]);
        keys.push(['stations', stationId, 'metrics']);
        keys.push(['stations', stationId, 'connectors']);
      }
      if (siteId != null) {
        keys.push(['sites', siteId, 'metrics']);
        keys.push(['sites', siteId, 'stations']);
        keys.push(['sites', siteId, 'layout']);
      }
      break;

    case 'session.started':
    case 'session.ended':
      keys.push(['dashboard', 'stats']);
      keys.push(['dashboard', 'session-history']);
      keys.push(['dashboard', 'energy-history']);
      keys.push(['dashboard', 'utilization']);
      keys.push(['dashboard', 'peak-usage']);
      keys.push(['dashboard', 'financial-stats']);
      keys.push(['dashboard', 'revenue-history']);
      keys.push(['sessions']);
      keys.push(['transactions']);
      if (stationId != null) {
        keys.push(['stations', stationId, 'metrics']);
        keys.push(['stations', stationId, 'sessions']);
        keys.push(['stations', stationId, 'revenue-history']);
      }
      if (siteId != null) {
        keys.push(['sites', siteId, 'metrics']);
        keys.push(['sites', siteId, 'sessions']);
        keys.push(['sites', siteId, 'layout']);
        keys.push(['sites', siteId, 'revenue-history']);
      }
      break;

    case 'session.updated':
      keys.push(['sessions']);
      keys.push(['transactions']);
      if (stationId != null) {
        keys.push(['stations', stationId, 'sessions']);
        keys.push(['stations', stationId, 'metrics']);
      }
      if (siteId != null) {
        keys.push(['sites', siteId, 'sessions']);
        keys.push(['sites', siteId, 'metrics']);
      }
      break;

    case 'meter.values':
      keys.push(['dashboard', 'financial-stats']);
      keys.push(['dashboard', 'revenue-history']);
      if (stationId != null) {
        keys.push(['stations', stationId, 'meter-values']);
        keys.push(['stations', stationId, 'energy-history']);
        keys.push(['stations', stationId, 'revenue-history']);
        keys.push(['stations', stationId, 'metrics']);
        keys.push(['station-meter-values']);
      }
      if (siteId != null) {
        keys.push(['sites', siteId, 'meter-values']);
        keys.push(['sites', siteId, 'energy-history']);
        keys.push(['sites', siteId, 'layout']);
        keys.push(['sites', siteId, 'load-management']);
        keys.push(['sites', siteId, 'revenue-history']);
        keys.push(['sites', siteId, 'metrics']);
      }
      break;

    case 'payment.settled':
      keys.push(['dashboard', 'stats']);
      keys.push(['dashboard', 'financial-stats']);
      keys.push(['dashboard', 'payment-breakdown']);
      keys.push(['transactions']);
      break;

    case 'load.updated':
      if (siteId != null) {
        keys.push(['sites', siteId, 'load-management']);
      }
      break;

    case 'ocpp.message':
      if (stationId != null) {
        keys.push(['stations', stationId, 'ocpp-logs']);
      }
      break;

    case 'station.securityEvent':
      if (stationId != null) {
        keys.push(['stations', stationId, 'security-logs']);
        keys.push(['stations', stationId, 'security-events']);
        // Auto-disable on a critical event flips availability, so refresh the
        // station detail query too.
        keys.push(['stations', stationId]);
      }
      break;

    case 'ocpp.health':
      keys.push(['dashboard', 'ocpp-health']);
      break;

    case 'supportCase.created':
    case 'supportCase.updated':
    case 'supportCase.newMessage':
      // Prefix also covers the detail page (['support-cases', id]).
      keys.push(['support-cases']);
      keys.push(['support-cases-unread-count']);
      break;

    case 'certificate.signed':
    case 'certificate.expiring':
    case 'certificate.expired':
      keys.push(['pnc-ca-certificates']);
      keys.push(['pnc-station-certificates']);
      keys.push(['pnc-csr-requests']);
      if (stationId != null) {
        keys.push(['stations', stationId, 'certificates']);
      }
      break;

    case 'octt.progress':
      keys.push(['octt-runs']);
      if (event.runId != null) {
        keys.push(['octt-runs', String(event.runId)]);
        keys.push(['octt-runs', String(event.runId), 'summary']);
      }
      break;

    case 'firmwareCampaign.stationUpdated':
    case 'firmwareCampaign.completed':
      // Prefix covers the list, detail, and sub-queries.
      keys.push(['firmware-campaigns']);
      break;

    case 'localAuthList.changed':
      // Must be ['local-auth-list', stationId]: the StationLocalAuthList query
      // is ['local-auth-list', stationId, page] and prefix matching starts at
      // index 0.
      if (stationId != null) {
        keys.push(['local-auth-list', stationId]);
      }
      break;

    case 'maintenance.changed':
      keys.push(['maintenance']);
      keys.push(['sites']);
      keys.push(['stations']);
      if (siteId != null) keys.push(['site', siteId]);
      break;

    case 'authorize.attempt':
      // The CSMS logged an authorize decision. Reload the Authorize Log page and
      // the Token / Station / Driver detail tabs.
      keys.push(['authorize-attempts']);
      break;

    case 'reservation.changed':
      // A reservation changed outside this operator's own action (worker, station
      // report, or another operator). Prefix also covers the detail page.
      keys.push(['reservations']);
      break;

    case 'roaming.session.changed':
      keys.push(['ocpi-sessions']);
      break;

    case 'roaming.cdr.changed':
      keys.push(['ocpi-cdrs']);
      break;

    case 'access.log':
      // The 'api' category is throttled at the source (app.ts).
      if (category === 'csms') keys.push(['access-logs-csms']);
      else if (category === 'portal') keys.push(['access-logs-portal']);
      else if (category === 'api') keys.push(['access-logs-api']);
      break;

    case 'token.changed':
      keys.push(['tokens']);
      // A token mutation changes the outcome the next authorize attempt
      // produces, so refresh any open authorize-log view.
      keys.push(['authorize-attempts']);
      break;

    case 'pricing.changed':
      // Prefix covers list, detail, tariffs, schedule, holidays, active-tariff.
      keys.push(['pricing-groups']);
      keys.push(['pricing-holidays']);
      keys.push(['active-tariff']);
      keys.push(['pricing-audit']);
      // assignment.changed events carry entity context so the affected detail
      // page also refreshes its pricing section.
      if (siteId != null) keys.push(['sites', siteId]);
      if (stationId != null) keys.push(['stations', stationId]);
      if (driverId != null) keys.push(['drivers', driverId]);
      if (fleetId != null) keys.push(['fleets', fleetId]);
      break;
  }

  return keys;
}
