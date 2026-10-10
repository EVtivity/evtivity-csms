// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Site isolation matrix: every operator route (`/v1`, not `/v1/portal`) is
 * either an entry of SITE_ISOLATION_MATRIX, tested against the real database
 * by `__integration__/99-site-isolation-matrix.integration.test.ts`, or an
 * entry of SITE_ISOLATION_ALLOWLIST with the reason it holds no site data.
 * The coverage guard (`site-isolation-coverage.test.ts`) fails when a route
 * is in neither, so a new route must be classified.
 *
 * Kinds:
 * - scoped: a request on another site's (or an unsited) resource. A
 *   site-restricted actor with the route permission gets 404 with
 *   `expectCode` (403 without the permission), and the other site's rows are
 *   unchanged after a write. Every write also has a positive control: the
 *   same request by an admin of site A on A's own resource passes the site
 *   check (`control`), so a refusal proves the site check and not an
 *   earlier validation error. `mixed` sends A's parent with B's child ids.
 * - list: a list or aggregate. A restricted actor gets 200 and no id, numeric
 *   id or name of the other site's (or unsited) resources appears in the
 *   body, while the all-site admin sees B's (and with `unsited` the unsited
 *   station's) data. `counts` asserts A-only totals.
 * - company: a company-wide feature. A restricted actor gets 404 with
 *   `expectCode`, the all-site admin succeeds (writes in the control phase).
 *
 * An entry whose expectation fails until a pending product fix lands carries
 * the review item number in a comment (`REVIEW2 #n`).
 */

export type MatrixMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The seeded resources of one site (or of the unsited station). */
export interface SiteFixture {
  site: string;
  siteName: string;
  station: string;
  ocpp: string;
  evse: number;
  connector: number;
  session: string;
  /** A session at the site's station with a pre-authorized payment. */
  preAuthSession: string;
  transactionId: string;
  payment: number;
  reservation: string;
  /** The OCPP reservation id of `reservation`. */
  reservationOcppId: number;
  feePayment: number;
  invoice: string;
  report: string;
  schedule: string;
  panel: string;
  circuit: string;
  load: string;
  csr: number;
  csr2: number;
  cdr: string;
  supportCase: string;
  message: number;
  attachment: number;
  configTemplate: string;
  configPush: string;
  /** A draft firmware campaign at the site. */
  campaign: string;
  /** An active firmware campaign at the site, for the cancel route. */
  activeCampaign: string;
  profileTemplate: string;
  profilePush: string;
  maintenance: string;
  downtime: string;
  image: number;
  display: number;
  ratePeriod: number;
  monitor: number;
  alert: number;
  user: string;
  fleetReservation: string;
  localAuthEntry: number;
}

/** Company-wide fixtures shared by both sites. */
export interface MatrixWorld {
  A: SiteFixture;
  B: SiteFixture;
  /**
   * The unsited station: station fields, CSRs, CDR and support case (message,
   * attachment) are its own, the rest are B's.
   */
  U: SiteFixture;
  driver: string;
  /** A second driver, member of no fleet. */
  driver2: string;
  token: string;
  /** Fleet with stations at A, B and the unsited station, billing details set. */
  fleet: string;
  /** Fleet with a pricing group: membership writes need all-site access. */
  pricedFleet: string;
  pricingGroup: string;
  tariff: string;
  partner: string;
  tariffMapping: number;
  alertRule: number;
  holiday: number;
  /** A role id for user creation. */
  role: string;
  /** A Plug and Charge trust store CA certificate. */
  caCertificate: number;
}

type UrlFn = (f: SiteFixture, w: MatrixWorld) => string;
type BodyFn = (f: SiteFixture, w: MatrixWorld) => unknown;

/**
 * The positive control of a write. Scoped: an admin of site A on A's resource
 * (`url(w.A)`, `body(w.A)`). Company: the all-site admin. Default: any 2xx.
 * A control that cannot succeed in the test database (no connected station,
 * no payment provider, no S3) states the status and code it gets after the
 * site check, and why.
 */
export interface ControlSpec {
  status?: number;
  code?: string;
  reason?: string;
  url?: UrlFn;
  body?: BodyFn;
  /** Runs later in the control phase (deletes run last, deepest path first). */
  order?: number;
}

/**
 * A's parent resource with another site's child ids: refused with `status`
 * (default 404) and `code`, or a 2xx that ignores the foreign ids; B's rows
 * are unchanged either way.
 */
export interface MixedSpec {
  url: (a: SiteFixture, f: SiteFixture, w: MatrixWorld) => string;
  body?: (a: SiteFixture, f: SiteFixture, w: MatrixWorld) => unknown;
  code?: string;
  status?: number;
}

/** A number in the response at `path` (dots, `length` of an array). */
export interface CountCheck {
  path: string;
  /** The all-site admin's value: A, B and the unsited station. */
  all: number;
  /** A site-A actor's value. */
  a: number;
  /** The no-site actor's value (default 0). */
  none?: number;
}

interface BaseEntry {
  method: MatrixMethod;
  /** Registered path relative to /v1. A trailing '*' covers a route family. */
  path: string;
  /** The route permission: an actor without it gets 403. */
  perm: string;
  /** Concrete URL relative to /v1. `f` is the foreign fixture (B or U). */
  url: UrlFn;
  body?: BodyFn;
}

export interface ScopedEntry extends BaseEntry {
  kind: 'scoped';
  /** The code of the site check's refusal. */
  expectCode: string;
  /** Also run against the unsited station. */
  unsited?: boolean;
  /** Expected status for a restricted actor holding the permission (default 404). */
  status?: number;
  /** Text the refusal body contains (a 200 with per-row errors). */
  expectText?: (f: SiteFixture) => string;
  /**
   * With `expectText`: the text the refusal of the actor without a site
   * contains (it is refused at its own site before `f` is reached). Without
   * it, that actor's refusal must carry `expectCode`.
   */
  noSitesText?: (f: SiteFixture, w: MatrixWorld) => string;
  /** Expected status of the all-site admin's fixture check of a GET (default 200). */
  adminStatus?: number;
  control?: ControlSpec;
  mixed?: MixedSpec[];
}

export interface ListEntry extends BaseEntry {
  kind: 'list';
  method: 'GET';
  /** The all-site admin also sees the unsited station's data. */
  unsited?: boolean;
  /** A-only totals: the admin sees more, restricted actors only A. */
  counts?: CountCheck[];
  /** Property names restricted actors must not receive. */
  hidden?: string[];
  /** The route takes no `limit` query parameter. */
  noLimit?: boolean;
  /**
   * The exact title of the dedicated case in the matrix integration test
   * that proves the filter, for a route whose response cannot show B's rows
   * to the all-site admin. A title that does not exist fails the run.
   */
  provenBy?: string;
}

export interface CompanyEntry extends BaseEntry {
  kind: 'company';
  /** The code of the all-site guard's refusal. */
  expectCode: string;
  /** Expected status of the all-site admin's GET (default 200). */
  adminStatus?: number;
  control?: ControlSpec;
}

export type MatrixEntry = ScopedEntry | ListEntry | CompanyEntry;

export interface AllowlistEntry {
  method: MatrixMethod;
  path: string;
  reason: string;
}

/** A self-signed test certificate: CSR sign validates the PEM before the site check. */
const TEST_CERTIFICATE_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBwDCCAWegAwIBAgIUZECvpIEtJpg5M81GyF1tIhfEW0wwCgYIKoZIzj0EAwIw\nNjELMAkGA1UEBhMCVVMxDTALBgNVBAoMBE9DVFQxGDAWBgNVBAMMD09DVFQgVGVz\ndCBTdWJDQTAeFw0yNjEwMDEwNDIwMDlaFw00NjA5MjYwNDIwMDlaMDYxCzAJBgNV\nBAYTAlVTMQ0wCwYDVQQKDARPQ1RUMRgwFgYDVQQDDA9PQ1RUIFRlc3QgU3ViQ0Ew\nWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAT+qQsfHqmJiCAQJkymKj708QyTL0Rn\nP4b77NukVQE05xLIfskSpe2DLXc3lNd29/OKm4fFEDG46Iz4QDZA1JC6o1MwUTAd\nBgNVHQ4EFgQUdHkHYZNbQefOYBAsx1d/dEQsQKMwHwYDVR0jBBgwFoAUdHkHYZNb\nQefOYBAsx1d/dEQsQKMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBE\nAiBGD8rOkl+2S1veyMAx/QHmPXf9P81hVEgKUS8pXFkm2QIgBNCse6lUAVjkTD2Q\nd8v4ytiikkthrqvxTvMQxx90720=\n-----END CERTIFICATE-----';

const iso = (offsetHours: number): string =>
  new Date(Date.now() + offsetHours * 3_600_000).toISOString();

type ScopedExtra = Partial<Omit<ScopedEntry, 'kind' | 'method' | 'path' | 'perm' | 'url'>>;
type ListExtra = Partial<Omit<ListEntry, 'kind' | 'method' | 'path' | 'perm' | 'url'>>;
type CompanyExtra = Partial<Omit<CompanyEntry, 'kind' | 'method' | 'path' | 'perm' | 'url'>>;

const s = (
  method: MatrixMethod,
  path: string,
  perm: string,
  url: UrlFn,
  expectCode: string,
  extra: ScopedExtra = {},
): ScopedEntry => ({ method, path, perm, kind: 'scoped', url, expectCode, ...extra });

const l = (path: string, perm: string, url?: UrlFn, extra: ListExtra = {}): ListEntry => ({
  method: 'GET',
  path,
  perm,
  kind: 'list',
  url: url ?? (() => path),
  ...extra,
});

const c = (
  method: MatrixMethod,
  path: string,
  perm: string,
  url: UrlFn,
  expectCode: string,
  extra: CompanyExtra = {},
): CompanyEntry => ({ method, path, perm, kind: 'company', url, expectCode, ...extra });

/** A control that passes the site check, then fails on what the test database lacks. */
const ctl = (
  status: number,
  code: string,
  reason: string,
  extra: Partial<ControlSpec> = {},
): ControlSpec => ({ status, code, reason, ...extra });

const OFFLINE = 'no station is connected in the test database';
const NO_PROVIDER = 'no payment provider is configured in the test database';
const NO_PROVIDER_PAYMENT = 'the seeded payments have no provider payment';
const NO_S3 = 'no S3 storage is configured in the test database';

const st = (f: SiteFixture): string => `/stations/${f.station}`;
const sit = (f: SiteFixture): string => `/sites/${f.site}`;

export const SITE_ISOLATION_MATRIX: MatrixEntry[] = [
  // access-logs, worker-logs: operator-wide logs, all-site only (route not found)
  c('GET', '/access-logs', 'logs:read', () => '/access-logs', 'ROUTE_NOT_FOUND'),
  c('GET', '/worker-logs', 'logs:read', () => '/worker-logs', 'ROUTE_NOT_FOUND'),

  // ad-hoc payments
  s('POST', '/ad-hoc-payments', 'payments:write', () => '/ad-hoc-payments', 'STATION_NOT_FOUND', {
    unsited: true,
    body: (f) => ({ stationId: f.ocpp, evseId: f.evse, pspRef: 'psp-ref-1' }),
    control: ctl(400, 'STATION_OFFLINE', OFFLINE),
  }),

  // payment provider settings (company-wide)
  c('GET', '/settings/adyen', 'payments:read', () => '/settings/adyen', 'SETTING_NOT_FOUND'),
  c('PUT', '/settings/adyen', 'payments:write', () => '/settings/adyen', 'SETTING_NOT_FOUND', {
    body: () => ({}),
  }),
  c(
    'POST',
    '/settings/adyen/test',
    'payments:write',
    () => '/settings/adyen/test',
    'SETTING_NOT_FOUND',
    {
      body: () => ({}),
      control: ctl(400, 'PAYMENT_PROVIDER_NOT_CONFIGURED', NO_PROVIDER),
    },
  ),
  // Not configured in the test database: the admin gets the provider's 400.
  c(
    'GET',
    '/settings/adyen/webhook',
    'payments:read',
    () => '/settings/adyen/webhook',
    'SETTING_NOT_FOUND',
    {
      adminStatus: 400,
    },
  ),
  c(
    'POST',
    '/settings/adyen/webhook',
    'payments:write',
    () => '/settings/adyen/webhook',
    'SETTING_NOT_FOUND',
    {
      body: () => ({ url: 'https://example.com/v1/webhooks/payments/adyen' }),
      control: ctl(400, 'PAYMENT_PROVIDER_NOT_CONFIGURED', NO_PROVIDER),
    },
  ),
  c('GET', '/settings/stripe', 'payments:read', () => '/settings/stripe', 'SETTING_NOT_FOUND'),
  c('PUT', '/settings/stripe', 'payments:write', () => '/settings/stripe', 'SETTING_NOT_FOUND', {
    body: () => ({}),
  }),
  c(
    'POST',
    '/settings/stripe/test',
    'payments:write',
    () => '/settings/stripe/test',
    'SETTING_NOT_FOUND',
    {
      body: () => ({}),
      control: ctl(400, 'PAYMENT_PROVIDER_NOT_CONFIGURED', NO_PROVIDER),
    },
  ),
  c(
    'GET',
    '/settings/stripe/webhook',
    'payments:read',
    () => '/settings/stripe/webhook',
    'SETTING_NOT_FOUND',
    {
      adminStatus: 400,
    },
  ),
  c(
    'POST',
    '/settings/stripe/webhook',
    'payments:write',
    () => '/settings/stripe/webhook',
    'SETTING_NOT_FOUND',
    {
      body: () => ({ url: 'https://example.com/v1/webhooks/payments/stripe', replace: false }),
      control: ctl(400, 'PAYMENT_PROVIDER_NOT_CONFIGURED', NO_PROVIDER),
    },
  ),
  c('GET', '/settings/payments', 'payments:read', () => '/settings/payments', 'SETTING_NOT_FOUND'),
  c(
    'PUT',
    '/settings/payments',
    'payments:write',
    () => '/settings/payments',
    'SETTING_NOT_FOUND',
    {
      body: () => ({}),
    },
  ),
  c(
    'GET',
    '/payments/reconciliation',
    'payments:read',
    () => '/payments/reconciliation',
    'PAYMENT_NOT_FOUND',
  ),
  c(
    'POST',
    '/payments/reconciliation/run',
    'payments:write',
    () => '/payments/reconciliation/run',
    'PAYMENT_NOT_FOUND',
    {
      body: () => ({}),
    },
  ),

  // audit
  l('/audit/:entityType/:entityId', 'audit:read', (f) => `/audit/station/${f.station}`, {}),
  l('/audit', 'audit:read', undefined, { unsited: true }),
  l('/authorize-attempts', 'drivers:read', undefined, { unsited: true }),

  // carbon
  l('/carbon/report', 'sessions:read'),
  l('/carbon/report/export', 'sessions:read'),

  // circuits
  s(
    'POST',
    '/sites/:siteId/panels/:panelId/circuits',
    'loadManagement:write',
    (f) => `${sit(f)}/panels/${f.panel}/circuits`,
    'PANEL_NOT_FOUND',
    {
      body: () => ({ name: 'Circuit X', breakerRatingAmps: 20 }),
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/panels/${f.panel}/circuits`,
          body: () => ({ name: 'Circuit X', breakerRatingAmps: 20 }),
          code: 'PANEL_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'GET',
    '/sites/:siteId/panels/:panelId/circuits',
    'loadManagement:read',
    (f) => `${sit(f)}/panels/${f.panel}/circuits`,
    'SITE_NOT_FOUND',
  ),
  s(
    'PATCH',
    '/sites/:siteId/panels/:panelId/circuits/:circuitId',
    'loadManagement:write',
    (f) => `${sit(f)}/panels/${f.panel}/circuits/${f.circuit}`,
    'CIRCUIT_NOT_FOUND',
    {
      body: () => ({ name: 'Renamed' }),
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/panels/${a.panel}/circuits/${f.circuit}`,
          body: () => ({ name: 'Renamed' }),
          code: 'CIRCUIT_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'DELETE',
    '/sites/:siteId/panels/:panelId/circuits/:circuitId',
    'loadManagement:write',
    (f) => `${sit(f)}/panels/${f.panel}/circuits/${f.circuit}`,
    'CIRCUIT_NOT_FOUND',
    {
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/panels/${a.panel}/circuits/${f.circuit}`,
          code: 'CIRCUIT_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'PATCH',
    '/sites/:siteId/stations/:stationId/circuit',
    'loadManagement:write',
    (f) => `${sit(f)}/stations/${f.station}/circuit`,
    'STATION_NOT_FOUND',
    {
      body: (f) => ({ circuitId: f.circuit }),
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/stations/${f.station}/circuit`,
          body: (a) => ({ circuitId: a.circuit }),
          code: 'STATION_NOT_FOUND',
        },
        {
          url: (a) => `/sites/${a.site}/stations/${a.station}/circuit`,
          body: (_a, f) => ({ circuitId: f.circuit }),
          status: 400,
          code: 'INVALID_CIRCUIT',
        },
      ],
    },
  ),

  // config templates
  l('/config-templates/filter-options', 'settings.stationConfig:read', undefined, {
    unsited: true,
  }),
  l('/config-templates', 'settings.stationConfig:read'),
  s(
    'GET',
    '/config-templates/:id',
    'settings.stationConfig:read',
    (f) => `/config-templates/${f.configTemplate}`,
    'TEMPLATE_NOT_FOUND',
  ),
  s(
    'POST',
    '/config-templates',
    'settings.stationConfig:write',
    () => '/config-templates',
    'SITE_NOT_FOUND',
    {
      body: (f) => ({
        name: 'Foreign target',
        variables: [{ component: 'C', variable: 'V', value: '1' }],
        targetFilter: { siteId: f.site },
      }),
    },
  ),
  s(
    'PATCH',
    '/config-templates/:id',
    'settings.stationConfig:write',
    (f) => `/config-templates/${f.configTemplate}`,
    'TEMPLATE_NOT_FOUND',
    { body: () => ({ name: 'Renamed' }) },
  ),
  s(
    'POST',
    '/config-templates/:id/duplicate',
    'settings.stationConfig:write',
    (f) => `/config-templates/${f.configTemplate}/duplicate`,
    'TEMPLATE_NOT_FOUND',
    { body: () => ({}) },
  ),
  s(
    'DELETE',
    '/config-templates/:id',
    'settings.stationConfig:write',
    (f) => `/config-templates/${f.configTemplate}`,
    'TEMPLATE_NOT_FOUND',
  ),
  s(
    'GET',
    '/config-templates/:id/matching-stations',
    'settings.stationConfig:read',
    (f) => `/config-templates/${f.configTemplate}/matching-stations`,
    'TEMPLATE_NOT_FOUND',
  ),
  s(
    'POST',
    '/config-templates/:id/push',
    'settings.stationConfig:write',
    (f) => `/config-templates/${f.configTemplate}/push`,
    'TEMPLATE_NOT_FOUND',
    { body: () => ({}) },
  ),
  s(
    'GET',
    '/config-templates/:id/pushes',
    'settings.stationConfig:read',
    (f) => `/config-templates/${f.configTemplate}/pushes`,
    'TEMPLATE_NOT_FOUND',
  ),
  s(
    'GET',
    '/config-template-pushes/:pushId',
    'settings.stationConfig:read',
    (f) => `/config-template-pushes/${f.configPush}`,
    'PUSH_NOT_FOUND',
  ),
  s(
    'GET',
    '/config-templates/:id/neighbors',
    'settings.stationConfig:read',
    (f) => `/config-templates/${f.configTemplate}/neighbors`,
    'TEMPLATE_NOT_FOUND',
  ),
  s(
    'GET',
    '/stations/:id/config-drift',
    'settings.stationConfig:read',
    (f) => `${st(f)}/config-drift`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),

  // CSS simulator
  s('POST', '/css/stations', 'stations:write', () => '/css/stations', 'STATION_NOT_FOUND', {
    unsited: true,
    body: (f) => ({ stationId: f.ocpp, targetUrl: 'ws://localhost:7103', evses: [{ evseId: 1 }] }),
    control: {
      body: (f) => ({
        stationId: 'MATRIX-CSS-CONTROL',
        targetUrl: 'ws://localhost:7103',
        evses: [{ evseId: 1 }],
        siteId: f.site,
      }),
    },
  }),
  l('/css/stations', 'stations:read', undefined, { unsited: true }),
  s(
    'GET',
    '/css/stations/:stationId',
    'stations:read',
    (f) => `/css/stations/${f.ocpp}`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'PATCH',
    '/css/stations/:stationId',
    'stations:write',
    (f) => `/css/stations/${f.ocpp}`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ model: 'Renamed' }),
    },
  ),
  s(
    'DELETE',
    '/css/stations/:stationId',
    'stations:write',
    (f) => `/css/stations/${f.ocpp}`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'POST',
    '/css/stations/:stationId/enable',
    'stations:write',
    (f) => `/css/stations/${f.ocpp}/enable`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}) },
  ),
  s(
    'POST',
    '/css/stations/:stationId/disable',
    'stations:write',
    (f) => `/css/stations/${f.ocpp}/disable`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}) },
  ),
  s('POST', '/css/actions/*', 'stations:write', () => '/css/actions/plugIn', 'STATION_NOT_FOUND', {
    unsited: true,
    body: (f) => ({ stationId: f.ocpp, evseId: 1 }),
    control: ctl(504, 'CSS_ACTION_TIMEOUT', 'no simulator answers in the test database'),
  }),

  // dashboard (aggregates)
  l('/dashboard/stats', 'dashboard:read', undefined, {
    counts: [
      { path: 'totalStations', all: 3, a: 1 },
      { path: 'totalSessions', all: 5, a: 2 },
      { path: 'totalEnergyWh', all: 3000, a: 1000 },
    ],
  }),
  l('/dashboard/energy-history', 'dashboard:read', undefined, {
    counts: [{ path: '@sum:energyWh', all: 3000, a: 1000 }],
  }),
  l('/dashboard/session-history', 'dashboard:read', undefined, {
    counts: [{ path: '@sum:count', all: 5, a: 2 }],
  }),
  l('/dashboard/station-status', 'dashboard:read', undefined, {
    counts: [{ path: '@sum:count', all: 3, a: 1 }],
  }),
  l('/dashboard/utilization', 'dashboard:read'),
  l('/dashboard/peak-usage', 'dashboard:read', undefined, {
    counts: [{ path: '@sum:count', all: 5, a: 2 }],
  }),
  l('/dashboard/financial-stats', 'dashboard:read', undefined, {
    counts: [
      { path: 'totalRevenueCents', all: 2100, a: 700 },
      { path: 'totalTransactions', all: 6, a: 2 },
    ],
  }),
  l('/dashboard/revenue-history', 'dashboard:read', undefined, {
    counts: [
      { path: '@sum:revenueCents', all: 2100, a: 700 },
      { path: '@sum:sessionCount', all: 3, a: 1 },
    ],
  }),
  l('/dashboard/payment-breakdown', 'dashboard:read', undefined, {
    counts: [
      { path: '@sum:totalCents', all: 2100, a: 700 },
      { path: '@sum:count', all: 8, a: 3 },
    ],
  }),
  l('/dashboard/uptime', 'dashboard:read', undefined, {
    counts: [{ path: 'totalPorts', all: 3, a: 1 }],
  }),
  // REVIEW2 #15: the OCPP process statistics are company-wide; restricted users get
  // their own stations' connections only.
  l('/dashboard/ocpp-health', 'dashboard:read', undefined, { hidden: ['instances'] }),
  l('/dashboard/site-locations', 'dashboard:read'),
  l('/dashboard/snapshots/trend', 'dashboard:read', undefined, {
    counts: [{ path: 'days.@sum:totalStations', all: 21, a: 1 }],
  }),
  l('/dashboard/snapshots/available-dates', 'dashboard:read', undefined, {
    counts: [{ path: 'length', all: 2, a: 1 }],
  }),
  l(
    '/dashboard/snapshots',
    'dashboard:read',
    () => `/dashboard/snapshots?date=${iso(-24).slice(0, 10)}`,
    { counts: [{ path: 'totalStations', all: 11, a: 1 }] },
  ),
  l('/dashboard/carbon-stats', 'dashboard:read', undefined, {
    counts: [
      { path: 'totalCo2AvoidedKg', all: 6, a: 2 },
      { path: 'sessionCount', all: 3, a: 1 },
    ],
  }),

  // display messages
  s(
    'GET',
    '/stations/:stationId/display-messages',
    'stations:read',
    (f) => `${st(f)}/display-messages`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'POST',
    '/stations/:stationId/display-messages',
    'stations:write',
    (f) => `${st(f)}/display-messages`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ priority: 'NormalCycle', format: 'UTF8', content: 'Hello' }),
      control: ctl(400, 'STATION_OFFLINE', OFFLINE),
    },
  ),
  s(
    'DELETE',
    '/stations/:stationId/display-messages/:id',
    'stations:write',
    (f) => `${st(f)}/display-messages/${String(f.display)}`,
    'MESSAGE_NOT_FOUND',
    {
      unsited: true,
      control: ctl(
        202,
        'COMMAND_QUEUED',
        'the station is offline: the OCPP server queues the clear for its reconnect',
      ),
      mixed: [
        {
          url: (a, f) => `/stations/${a.station}/display-messages/${String(f.display)}`,
          code: 'MESSAGE_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'POST',
    '/stations/:stationId/display-messages/refresh',
    'stations:write',
    (f) => `${st(f)}/display-messages/refresh`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}), control: ctl(400, 'STATION_OFFLINE', OFFLINE) },
  ),

  // driver history (the driver is company-wide, its history is per site)
  l('/drivers/:id/sessions', 'drivers:read', (_f, w) => `/drivers/${w.driver}/sessions`, {
    unsited: true,
  }),
  l('/drivers/:id/reservations', 'drivers:read', (_f, w) => `/drivers/${w.driver}/reservations`, {
    unsited: true,
  }),
  c(
    'POST',
    '/drivers/:id/pricing-groups',
    'drivers:write',
    (_f, w) => `/drivers/${w.driver}/pricing-groups`,
    'PRICING_GROUP_NOT_FOUND',
    { body: (_f, w) => ({ pricingGroupId: w.pricingGroup }) },
  ),
  c(
    'DELETE',
    '/drivers/:id/pricing-groups/:pricingGroupId',
    'drivers:write',
    (_f, w) => `/drivers/${w.driver}/pricing-groups/${w.pricingGroup}`,
    'PRICING_GROUP_NOT_FOUND',
  ),

  // event alert rules (company-wide writes)
  c('POST', '/event-alert-rules', 'stations:write', () => '/event-alert-rules', 'RULE_NOT_FOUND', {
    body: () => ({ component: 'EVSE', variable: 'Problem' }),
    control: { body: () => ({ component: 'EVSE', variable: 'Control' }) },
  }),
  c(
    'PATCH',
    '/event-alert-rules/:id',
    'stations:write',
    (_f, w) => `/event-alert-rules/${String(w.alertRule)}`,
    'RULE_NOT_FOUND',
    {
      body: () => ({ component: 'EVSE' }),
    },
  ),
  c(
    'DELETE',
    '/event-alert-rules/:id',
    'stations:write',
    (_f, w) => `/event-alert-rules/${String(w.alertRule)}`,
    'RULE_NOT_FOUND',
  ),

  // firmware campaigns
  l('/firmware-campaigns/filter-options', 'settings.firmware:read', undefined, { unsited: true }),
  l('/firmware-campaigns', 'settings.firmware:read'),
  s(
    'GET',
    '/firmware-campaigns/:id',
    'settings.firmware:read',
    (f) => `/firmware-campaigns/${f.campaign}`,
    'CAMPAIGN_NOT_FOUND',
  ),
  s(
    'POST',
    '/firmware-campaigns',
    'settings.firmware:write',
    () => '/firmware-campaigns',
    'SITE_NOT_FOUND',
    {
      body: (f) => ({
        name: 'Foreign campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        targetFilter: { siteId: f.site },
      }),
    },
  ),
  s(
    'PATCH',
    '/firmware-campaigns/:id',
    'settings.firmware:write',
    (f) => `/firmware-campaigns/${f.campaign}`,
    'CAMPAIGN_NOT_FOUND',
    { body: () => ({ name: 'Renamed' }) },
  ),
  s(
    'DELETE',
    '/firmware-campaigns/:id',
    'settings.firmware:write',
    (f) => `/firmware-campaigns/${f.campaign}`,
    'CAMPAIGN_NOT_FOUND',
  ),
  s(
    'GET',
    '/firmware-campaigns/:id/matching-stations',
    'settings.firmware:read',
    (f) => `/firmware-campaigns/${f.campaign}/matching-stations`,
    'CAMPAIGN_NOT_FOUND',
  ),
  s(
    'POST',
    '/firmware-campaigns/:id/start',
    'settings.firmware:write',
    (f) => `/firmware-campaigns/${f.campaign}/start`,
    'CAMPAIGN_NOT_FOUND',
    {
      body: () => ({}),
      control: ctl(409, 'NO_TARGETS', 'no station is connected, so none matches the campaign'),
    },
  ),
  s(
    'GET',
    '/firmware-campaigns/:id/neighbors',
    'settings.firmware:read',
    (f) => `/firmware-campaigns/${f.campaign}/neighbors`,
    'CAMPAIGN_NOT_FOUND',
  ),
  s(
    'POST',
    '/firmware-campaigns/:id/cancel',
    'settings.firmware:write',
    (f) => `/firmware-campaigns/${f.activeCampaign}/cancel`,
    'CAMPAIGN_NOT_FOUND',
    { body: () => ({}) },
  ),

  // fleet billing (company-wide)
  c(
    'GET',
    '/fleets/:id/billing/unbilled',
    'payments:read',
    (_f, w) => `/fleets/${w.fleet}/billing/unbilled`,
    'FLEET_NOT_FOUND',
  ),
  c(
    'POST',
    '/fleets/:id/invoices',
    'payments:write',
    (_f, w) => `/fleets/${w.fleet}/invoices`,
    'FLEET_NOT_FOUND',
    {
      body: () => ({ period: '2026-01' }),
      control: ctl(
        409,
        'FLEET_INVOICE_NOTHING_TO_BILL',
        'the fleet has no billed session in the period',
      ),
    },
  ),
  c(
    'GET',
    '/fleets/:id/invoices',
    'payments:read',
    (_f, w) => `/fleets/${w.fleet}/invoices`,
    'FLEET_NOT_FOUND',
  ),
  c(
    'PATCH',
    '/fleets/:id/billing',
    'fleets:write',
    (_f, w) => `/fleets/${w.fleet}/billing`,
    'FLEET_NOT_FOUND',
    {
      body: () => ({ accountBillingEnabled: false }),
    },
  ),
  c(
    'PATCH',
    '/fleets/:id/billing-profile',
    'fleets:write',
    (_f, w) => `/fleets/${w.fleet}/billing-profile`,
    'FLEET_NOT_FOUND',
    { body: () => ({}) },
  ),
  c(
    'GET',
    '/fleets/:id/credit-limit',
    'fleets:read',
    (_f, w) => `/fleets/${w.fleet}/credit-limit`,
    'FLEET_NOT_FOUND',
  ),
  c(
    'PATCH',
    '/fleets/:id/credit-limit',
    'fleets:write',
    (_f, w) => `/fleets/${w.fleet}/credit-limit`,
    'FLEET_NOT_FOUND',
    { body: () => ({}) },
  ),
  c(
    'POST',
    '/fleets/:id/pricing-groups',
    'fleets:write',
    (_f, w) => `/fleets/${w.fleet}/pricing-groups`,
    'PRICING_GROUP_NOT_FOUND',
    { body: (_f, w) => ({ pricingGroupId: w.pricingGroup }) },
  ),
  c(
    'DELETE',
    '/fleets/:id/pricing-groups/:pricingGroupId',
    'fleets:write',
    (_f, w) => `/fleets/${w.fleet}/pricing-groups/${w.pricingGroup}`,
    'PRICING_GROUP_NOT_FOUND',
  ),

  // fleet reservations
  s(
    'POST',
    '/fleets/:fleetId/reservations',
    'reservations:write',
    (_f, w) => `/fleets/${w.fleet}/reservations`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (f) => ({ slots: [{ stationOcppId: f.ocpp }], expiresAt: iso(2) }),
    },
  ),
  l(
    '/fleets/:fleetId/reservations',
    'reservations:read',
    (_f, w) => `/fleets/${w.fleet}/reservations`,
  ),
  s(
    'DELETE',
    '/fleet-reservations/:id',
    'reservations:write',
    (f) => `/fleet-reservations/${f.fleetReservation}`,
    'FLEET_RESERVATION_NOT_FOUND',
  ),

  // fleet stations and history
  l('/fleets/:id/stations', 'fleets:read', (_f, w) => `/fleets/${w.fleet}/stations`, {
    unsited: true,
  }),
  s(
    'POST',
    '/fleets/:id/stations',
    'fleets:write',
    (_f, w) => `/fleets/${w.fleet}/stations`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (f) => ({ stationId: f.station }),
      control: ctl(409, 'STATION_ALREADY_IN_FLEET', 'the seed puts station A in the fleet'),
    },
  ),
  s(
    'DELETE',
    '/fleets/:id/stations/:stationId',
    'fleets:write',
    (f, w) => `/fleets/${w.fleet}/stations/${f.station}`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),
  l('/fleets/:id/sessions', 'fleets:read', (_f, w) => `/fleets/${w.fleet}/sessions`, {
    unsited: true,
  }),
  l('/fleets/:id/metrics', 'fleets:read', (_f, w) => `/fleets/${w.fleet}/metrics`, {
    counts: [
      { path: 'totalSessions', all: 3, a: 1 },
      { path: 'totalEnergyWh', all: 3000, a: 1000 },
    ],
  }),
  l('/fleets/:id/energy-history', 'fleets:read', (_f, w) => `/fleets/${w.fleet}/energy-history`, {
    counts: [{ path: '@sum:energyWh', all: 3000, a: 1000 }],
  }),

  // holidays (company-wide writes)
  c('POST', '/pricing-holidays', 'pricing:write', () => '/pricing-holidays', 'HOLIDAY_NOT_FOUND', {
    body: () => ({ name: 'Holiday', date: '2026-12-25' }),
    control: { body: () => ({ name: 'Control', date: '2026-12-26' }) },
  }),
  c(
    'DELETE',
    '/pricing-holidays/:id',
    'pricing:write',
    (_f, w) => `/pricing-holidays/${String(w.holiday)}`,
    'HOLIDAY_NOT_FOUND',
  ),
  c(
    'POST',
    '/pricing-holidays/bulk',
    'pricing:write',
    () => '/pricing-holidays/bulk',
    'HOLIDAY_NOT_FOUND',
    {
      body: () => ({ holidays: [{ name: 'Holiday', date: '2026-11-11' }] }),
    },
  ),

  // invoices (company-wide, except the session invoice)
  c('GET', '/invoices', 'payments:read', () => '/invoices', 'INVOICE_NOT_FOUND'),
  c('GET', '/invoices/:id', 'payments:read', (f) => `/invoices/${f.invoice}`, 'INVOICE_NOT_FOUND'),
  s(
    'POST',
    '/invoices/session/:sessionId',
    'payments:write',
    (f) => `/invoices/session/${f.session}`,
    'SESSION_NOT_FOUND',
    { unsited: true, body: () => ({}) },
  ),
  c(
    'POST',
    '/invoices/aggregated',
    'payments:write',
    () => '/invoices/aggregated',
    'INVOICE_NOT_FOUND',
    {
      body: (_f, w) => ({ driverId: w.driver, startDate: iso(-48), endDate: iso(-24) }),
      control: ctl(400, 'INVOICE_NO_SESSIONS', 'the driver has no uninvoiced session in the range'),
    },
  ),
  c(
    'PATCH',
    '/invoices/:id/void',
    'payments:write',
    (f) => `/invoices/${f.invoice}/void`,
    'INVOICE_NOT_FOUND',
    {
      body: () => ({}),
      control: ctl(409, 'INVOICE_NOT_VOIDABLE', 'the seeded invoice is issued, not a draft'),
    },
  ),
  c(
    'PATCH',
    '/invoices/:id/paid',
    'payments:write',
    (f) => `/invoices/${f.invoice}/paid`,
    'INVOICE_NOT_FOUND',
    {
      body: () => ({ paidAt: iso(0) }),
    },
  ),
  c(
    'POST',
    '/invoices/:id/credit-note',
    'payments:write',
    (f) => `/invoices/${f.invoice}/credit-note`,
    'INVOICE_NOT_FOUND',
    { body: () => ({ reason: 'Refund' }) },
  ),
  c(
    'POST',
    '/invoices/:id/send',
    'payments:write',
    (f) => `/invoices/${f.invoice}/send`,
    'INVOICE_NOT_FOUND',
    {
      body: () => ({}),
    },
  ),
  c(
    'GET',
    '/invoices/print-logo',
    'payments:read',
    () => '/invoices/print-logo',
    'INVOICE_NOT_FOUND',
  ),
  c(
    'GET',
    '/invoices/:id/pdf',
    'payments:read',
    (f) => `/invoices/${f.invoice}/pdf`,
    'INVOICE_NOT_FOUND',
  ),
  c(
    'GET',
    '/invoices/:id/download',
    'payments:read',
    (f) => `/invoices/${f.invoice}/download`,
    'INVOICE_NOT_FOUND',
  ),
  c(
    'GET',
    '/invoices/:id/neighbors',
    'payments:read',
    (f) => `/invoices/${f.invoice}/neighbors`,
    'INVOICE_NOT_FOUND',
  ),

  // load management
  s(
    'GET',
    '/sites/:id/load-management',
    'loadManagement:read',
    (f) => `${sit(f)}/load-management`,
    'SITE_NOT_FOUND',
  ),
  s(
    'PUT',
    '/sites/:id/load-management',
    'loadManagement:write',
    (f) => `${sit(f)}/load-management`,
    'SITE_NOT_FOUND',
    { body: () => ({ strategy: 'equal_share', isEnabled: true }) },
  ),
  s(
    'PATCH',
    '/sites/:id/stations/:stationId/load-priority',
    'loadManagement:write',
    (f) => `${sit(f)}/stations/${f.station}/load-priority`,
    'STATION_NOT_FOUND',
    {
      body: () => ({ loadPriority: 2 }),
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/stations/${f.station}/load-priority`,
          body: () => ({ loadPriority: 2 }),
          code: 'STATION_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'GET',
    '/sites/:id/load-management/history',
    'loadManagement:read',
    (f) => `${sit(f)}/load-management/history`,
    'SITE_NOT_FOUND',
  ),

  // local auth list
  s(
    'GET',
    '/stations/:stationId/local-auth-list',
    'stations:read',
    (f) => `${st(f)}/local-auth-list`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'GET',
    '/stations/:stationId/local-auth-list/available-tokens',
    'stations:read',
    (f) => `${st(f)}/local-auth-list/available-tokens`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'POST',
    '/stations/:stationId/local-auth-list/push',
    'stations:write',
    (f) => `${st(f)}/local-auth-list/push`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}), control: ctl(400, 'STATION_OFFLINE', OFFLINE) },
  ),
  s(
    'POST',
    '/stations/:stationId/local-auth-list/add',
    'stations:write',
    (f) => `${st(f)}/local-auth-list/add`,
    'STATION_NOT_FOUND',
    { unsited: true, body: (_f, w) => ({ tokenIds: [w.token] }) },
  ),
  s(
    'POST',
    '/stations/:stationId/local-auth-list/remove',
    'stations:write',
    (f) => `${st(f)}/local-auth-list/remove`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (f) => ({ entryIds: [f.localAuthEntry] }),
      mixed: [
        {
          url: (a) => `/stations/${a.station}/local-auth-list/remove`,
          body: (_a, f) => ({ entryIds: [f.localAuthEntry] }),
          status: 400,
          code: 'NO_VALID_ENTRIES',
        },
      ],
    },
  ),

  // maintenance
  s(
    'GET',
    '/sites/:siteId/maintenance/events',
    'maintenance:read',
    (f) => `${sit(f)}/maintenance/events`,
    'SITE_NOT_FOUND',
  ),
  s(
    'GET',
    '/sites/:siteId/maintenance/events/:id/stations',
    'maintenance:read',
    (f) => `${sit(f)}/maintenance/events/${f.maintenance}/stations`,
    'SITE_NOT_FOUND',
    {
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/maintenance/events/${f.maintenance}/stations`,
          code: 'MAINTENANCE_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'POST',
    '/sites/:siteId/maintenance/events',
    'maintenance:write',
    (f) => `${sit(f)}/maintenance/events`,
    'SITE_NOT_FOUND',
    {
      body: () => ({ eventType: 'one_off', plannedStartAt: iso(24), plannedEndAt: iso(26) }),
      control: {
        body: () => ({ eventType: 'one_off', plannedStartAt: iso(48), plannedEndAt: iso(50) }),
      },
    },
  ),
  s(
    'GET',
    '/sites/:siteId/maintenance/events/:id',
    'maintenance:read',
    (f) => `${sit(f)}/maintenance/events/${f.maintenance}`,
    'SITE_NOT_FOUND',
    {
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/maintenance/events/${f.maintenance}`,
          code: 'MAINTENANCE_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'PATCH',
    '/sites/:siteId/maintenance/events/:id',
    'maintenance:write',
    (f) => `${sit(f)}/maintenance/events/${f.maintenance}`,
    'SITE_NOT_FOUND',
    { body: () => ({ reason: 'Changed' }) },
  ),
  s(
    'POST',
    '/sites/:siteId/maintenance/events/:id/cancel',
    'maintenance:write',
    (f) => `${sit(f)}/maintenance/events/${f.maintenance}/cancel`,
    'SITE_NOT_FOUND',
    { body: () => ({}), control: { order: 1 } },
  ),
  s(
    'POST',
    '/sites/:siteId/maintenance/events/:id/add-stations',
    'maintenance:write',
    (f) => `${sit(f)}/maintenance/events/${f.maintenance}/add-stations`,
    'SITE_NOT_FOUND',
    {
      body: (f) => ({ stationIds: [f.station] }),
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/maintenance/events/${f.maintenance}/add-stations`,
          body: (a) => ({ stationIds: [a.station] }),
          code: 'MAINTENANCE_NOT_FOUND',
        },
        {
          url: (a) => `/sites/${a.site}/maintenance/events/${a.maintenance}/add-stations`,
          body: (_a, f) => ({ stationIds: [f.station] }),
          status: 400,
          code: 'STATION_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'POST',
    '/sites/:siteId/maintenance/events/:id/remove-stations',
    'maintenance:write',
    (f) => `${sit(f)}/maintenance/events/${f.maintenance}/remove-stations`,
    'SITE_NOT_FOUND',
    {
      body: (f) => ({ stationIds: [f.station] }),
    },
  ),
  s(
    'GET',
    '/sites/:siteId/maintenance/status',
    'maintenance:read',
    (f) => `${sit(f)}/maintenance/status`,
    'SITE_NOT_FOUND',
  ),
  s(
    'GET',
    '/sites/:siteId/maintenance/station-preview',
    'maintenance:read',
    (f) => `${sit(f)}/maintenance/station-preview?startAt=${iso(24)}&endAt=${iso(26)}`,
    'SITE_NOT_FOUND',
  ),

  // NEVI
  l('/nevi/station-data', 'reports:read', undefined, { unsited: true }),
  s(
    'PUT',
    '/nevi/station-data/:stationId',
    'reports:write',
    (f) => `/nevi/station-data/${f.station}`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}) },
  ),
  l('/nevi/excluded-downtime', 'reports:read', undefined, { unsited: true }),
  s(
    'POST',
    '/nevi/excluded-downtime',
    'reports:write',
    () => '/nevi/excluded-downtime',
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (f) => ({
        stationId: f.station,
        evseId: f.evse,
        reason: 'utility_outage',
        startedAt: iso(-2),
      }),
    },
  ),
  s(
    'PATCH',
    '/nevi/excluded-downtime/:id',
    'reports:write',
    (f) => `/nevi/excluded-downtime/${f.downtime}`,
    'DOWNTIME_NOT_FOUND',
    { body: () => ({ notes: 'Changed' }) },
  ),
  s(
    'DELETE',
    '/nevi/excluded-downtime/:id',
    'reports:write',
    (f) => `/nevi/excluded-downtime/${f.downtime}`,
    'DOWNTIME_NOT_FOUND',
  ),

  // notifications (company-wide)
  c(
    'PUT',
    '/ocpp-event-settings',
    'notifications:write',
    () => '/ocpp-event-settings',
    'SETTING_NOT_FOUND',
    {
      body: () => ({ eventType: 'station.Disconnected' }),
    },
  ),
  c(
    'DELETE',
    '/ocpp-event-settings',
    'notifications:write',
    () => '/ocpp-event-settings?eventType=station.Disconnected&channel=email',
    'SETTING_NOT_FOUND',
  ),
  c('GET', '/notifications', 'notifications:read', () => '/notifications', 'MESSAGE_NOT_FOUND'),
  c(
    'POST',
    '/notifications/test',
    'notifications:write',
    () => '/notifications/test',
    'SETTING_NOT_FOUND',
    {
      body: () => ({ channel: 'email', recipient: 'test@example.com' }),
      control: ctl(
        400,
        'EMAIL_NOT_CONFIGURED',
        'no SMTP server is configured in the test database',
      ),
    },
  ),
  c(
    'PUT',
    '/driver-event-settings',
    'notifications:write',
    () => '/driver-event-settings',
    'SETTING_NOT_FOUND',
    {
      body: () => ({ eventType: 'session.Started', isEnabled: false }),
    },
  ),
  c(
    'PUT',
    '/notification-templates',
    'notifications:write',
    () => '/notification-templates',
    'TEMPLATE_NOT_FOUND',
    {
      body: () => ({ eventType: 'session.Started', channel: 'email', language: 'en' }),
    },
  ),
  c(
    'DELETE',
    '/notification-templates',
    'notifications:write',
    () => '/notification-templates?eventType=session.Started&channel=email&language=en',
    'TEMPLATE_NOT_FOUND',
  ),

  // OCPI
  l('/ocpi/cdrs', 'roaming:read', undefined, { unsited: true }),
  s('POST', '/ocpi/cdrs/credit', 'roaming:write', () => '/ocpi/cdrs/credit', 'CDR_NOT_FOUND', {
    unsited: true,
    body: (f) => ({ originalCdrId: f.cdr, reason: 'Credit' }),
  }),
  l('/ocpi/locations', 'roaming:read'),
  s(
    'GET',
    '/ocpi/locations/:siteId',
    'roaming:read',
    (f) => `/ocpi/locations/${f.site}`,
    'SITE_NOT_FOUND',
  ),
  s(
    'PUT',
    '/ocpi/locations/:siteId',
    'roaming:write',
    (f) => `/ocpi/locations/${f.site}`,
    'SITE_NOT_FOUND',
    {
      body: () => ({ isPublished: true }),
    },
  ),
  l('/ocpi/sessions', 'roaming:read'),
  c('GET', '/ocpi/partners', 'roaming:read', () => '/ocpi/partners', 'PARTNER_NOT_FOUND'),
  c(
    'GET',
    '/ocpi/partners/:id',
    'roaming:read',
    (_f, w) => `/ocpi/partners/${w.partner}`,
    'PARTNER_NOT_FOUND',
  ),
  c('POST', '/ocpi/partners', 'roaming:write', () => '/ocpi/partners', 'PARTNER_NOT_FOUND', {
    body: () => ({ name: 'New partner', countryCode: 'DE', partyId: 'XYZ' }),
  }),
  c(
    'PATCH',
    '/ocpi/partners/:id',
    'roaming:write',
    (_f, w) => `/ocpi/partners/${w.partner}`,
    'PARTNER_NOT_FOUND',
    {
      body: () => ({}),
    },
  ),
  c(
    'DELETE',
    '/ocpi/partners/:id',
    'roaming:write',
    (_f, w) => `/ocpi/partners/${w.partner}`,
    'PARTNER_NOT_FOUND',
  ),
  c(
    'POST',
    '/ocpi/partners/:id/register',
    'roaming:write',
    (_f, w) => `/ocpi/partners/${w.partner}/register`,
    'PARTNER_NOT_FOUND',
    {
      body: () => ({}),
      control: ctl(400, 'MISSING_VERSION_URL', 'the seeded partner has no version URL'),
    },
  ),
  c(
    'POST',
    '/ocpi/partners/:id/sync/:module',
    'roaming:write',
    (_f, w) => `/ocpi/partners/${w.partner}/sync/locations`,
    'PARTNER_NOT_FOUND',
    { body: () => ({}) },
  ),
  c(
    'GET',
    '/ocpi/partners/:id/neighbors',
    'roaming:read',
    (_f, w) => `/ocpi/partners/${w.partner}/neighbors`,
    'PARTNER_NOT_FOUND',
  ),
  c('GET', '/ocpi/sync-log', 'roaming:read', () => '/ocpi/sync-log', 'PARTNER_NOT_FOUND'),
  c(
    'GET',
    '/ocpi/tariff-mappings',
    'roaming:read',
    () => '/ocpi/tariff-mappings',
    'MAPPING_NOT_FOUND',
  ),
  c(
    'GET',
    '/ocpi/tariff-mappings/:id',
    'roaming:read',
    (_f, w) => `/ocpi/tariff-mappings/${String(w.tariffMapping)}`,
    'MAPPING_NOT_FOUND',
  ),
  c(
    'POST',
    '/ocpi/tariff-mappings',
    'roaming:write',
    () => '/ocpi/tariff-mappings',
    'MAPPING_NOT_FOUND',
    {
      body: (_f, w) => ({ ocpiTariffId: 'TARIFF-2', tariffId: w.tariff, partnerId: w.partner }),
    },
  ),
  c(
    'PATCH',
    '/ocpi/tariff-mappings/:id',
    'roaming:write',
    (_f, w) => `/ocpi/tariff-mappings/${String(w.tariffMapping)}`,
    'MAPPING_NOT_FOUND',
    {
      body: () => ({}),
    },
  ),
  c(
    'DELETE',
    '/ocpi/tariff-mappings/:id',
    'roaming:write',
    (_f, w) => `/ocpi/tariff-mappings/${String(w.tariffMapping)}`,
    'MAPPING_NOT_FOUND',
    { control: { order: 990 } },
  ),

  // OCPP commands (one representative per family; all share commandRoute)
  s(
    'POST',
    '/ocpp/commands/*/*',
    'stations:write',
    () => '/ocpp/commands/v21/Reset',
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (f) => ({ stationId: f.ocpp, type: 'Immediate' }),
    },
  ),
  s(
    'POST',
    '/ocpp/commands/v21/GetVariables',
    'stations:write',
    () => '/ocpp/commands/v21/GetVariables',
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (f) => ({
        stationId: f.ocpp,
        getVariableData: [
          { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
        ],
      }),
    },
  ),

  // conformance (company-wide write)
  c('POST', '/octt/runs', 'conformance:write', () => '/octt/runs', 'OCTT_RUN_NOT_FOUND', {
    body: () => ({}),
  }),

  // panels
  s(
    'POST',
    '/sites/:siteId/panels',
    'loadManagement:write',
    (f) => `${sit(f)}/panels`,
    'SITE_NOT_FOUND',
    {
      body: () => ({ name: 'Panel X', breakerRatingAmps: 100, voltageV: 240, phases: 1 }),
    },
  ),
  s(
    'GET',
    '/sites/:siteId/panels',
    'loadManagement:read',
    (f) => `${sit(f)}/panels`,
    'SITE_NOT_FOUND',
  ),
  s(
    'GET',
    '/sites/:siteId/panels/:panelId',
    'loadManagement:read',
    (f) => `${sit(f)}/panels/${f.panel}`,
    'PANEL_NOT_FOUND',
    { mixed: [{ url: (a, f) => `/sites/${a.site}/panels/${f.panel}`, code: 'PANEL_NOT_FOUND' }] },
  ),
  s(
    'PATCH',
    '/sites/:siteId/panels/:panelId',
    'loadManagement:write',
    (f) => `${sit(f)}/panels/${f.panel}`,
    'PANEL_NOT_FOUND',
    {
      body: () => ({ name: 'Renamed' }),
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/panels/${f.panel}`,
          body: () => ({ name: 'Renamed' }),
          code: 'PANEL_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'DELETE',
    '/sites/:siteId/panels/:panelId',
    'loadManagement:write',
    (f) => `${sit(f)}/panels/${f.panel}`,
    'PANEL_NOT_FOUND',
  ),

  // payments
  s(
    'GET',
    '/sites/:id/payment-config',
    'payments:read',
    (f) => `${sit(f)}/payment-config`,
    'PAYMENT_CONFIG_NOT_FOUND',
  ),
  s(
    'PUT',
    '/sites/:id/payment-config',
    'payments:write',
    (f) => `${sit(f)}/payment-config`,
    'PAYMENT_CONFIG_NOT_FOUND',
    {
      body: () => ({ enabled: false }),
    },
  ),
  s(
    'DELETE',
    '/sites/:id/payment-config',
    'payments:write',
    (f) => `${sit(f)}/payment-config`,
    'PAYMENT_CONFIG_NOT_FOUND',
  ),
  l('/sites/payment-configs', 'payments:read'),
  s(
    'POST',
    '/sessions/:id/pre-authorize',
    'payments:write',
    (f) => `/sessions/${f.session}/pre-authorize`,
    'SESSION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ paymentMethodId: 1 }),
      control: ctl(400, 'PRE_AUTH_FAILED', 'the seeded session already has a payment record'),
    },
  ),
  s(
    'POST',
    '/sessions/:id/capture',
    'payments:write',
    // The pre-authorized session: without the site check the capture would
    // reach the hold (400 MISSING_PAYMENT_INTENT) instead of 404.
    (f) => `/sessions/${f.preAuthSession}/capture`,
    'NO_PRE_AUTH',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(400, 'MISSING_PAYMENT_INTENT', NO_PROVIDER_PAYMENT),
    },
  ),
  s(
    'POST',
    '/sessions/:id/refund',
    'payments:write',
    (f) => `/sessions/${f.session}/refund`,
    'PAYMENT_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(400, 'MISSING_PAYMENT_INTENT', NO_PROVIDER_PAYMENT),
    },
  ),
  s(
    'GET',
    '/reservations/:id/fee-payments',
    'payments:read',
    (f) => `/reservations/${f.reservation}/fee-payments`,
    'RESERVATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'POST',
    '/reservations/:id/fee-payments/:paymentId/refund',
    'payments:write',
    (f) => `/reservations/${f.reservation}/fee-payments/${String(f.feePayment)}/refund`,
    'PAYMENT_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(400, 'MISSING_PAYMENT_INTENT', NO_PROVIDER_PAYMENT),
      mixed: [
        {
          url: (a, f) =>
            `/reservations/${a.reservation}/fee-payments/${String(f.feePayment)}/refund`,
          body: () => ({}),
          code: 'PAYMENT_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'GET',
    '/sessions/:id/payment',
    'payments:read',
    (f) => `/sessions/${f.session}/payment`,
    'PAYMENT_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'POST',
    '/payments/:id/retry-capture',
    'payments:write',
    (f) => `/payments/${String(f.payment)}/retry-capture`,
    'PAYMENT_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(409, 'PAYMENT_RECORD_NOT_RECOVERABLE', NO_PROVIDER_PAYMENT),
    },
  ),
  l('/payments', 'payments:read', undefined, { unsited: true }),

  // payout accounts
  s(
    'GET',
    '/sites/:id/payout-account',
    'payments:read',
    (f) => `${sit(f)}/payout-account`,
    'SITE_NOT_FOUND',
  ),
  s(
    'POST',
    '/sites/:id/payout-account',
    'payments:write',
    (f) => `${sit(f)}/payout-account`,
    'SITE_NOT_FOUND',
    {
      body: () => ({ contactEmail: 'owner@example.com' }),
      control: ctl(400, 'PAYMENT_PROVIDER_NOT_CONFIGURED', NO_PROVIDER),
    },
  ),
  s(
    'POST',
    '/sites/:id/payout-account/refresh',
    'payments:write',
    (f) => `${sit(f)}/payout-account/refresh`,
    'SITE_NOT_FOUND',
    {
      body: () => ({}),
      control: ctl(409, 'PAYOUT_ACCOUNT_NOT_READY', 'site A has no payout account'),
    },
  ),
  s(
    'POST',
    '/sites/:id/payout-account/invite',
    'payments:write',
    (f) => `${sit(f)}/payout-account/invite`,
    'SITE_NOT_FOUND',
    {
      body: () => ({ send: 'none' }),
      control: ctl(409, 'PAYOUT_ACCOUNT_NOT_READY', 'site A has no payout account'),
    },
  ),

  // Plug and Charge
  l('/pnc/csr-requests', 'certificates:read', undefined, { unsited: true }),
  s(
    'POST',
    '/pnc/csr-requests/:id/sign',
    'certificates:write',
    (f) => `/pnc/csr-requests/${String(f.csr)}/sign`,
    'CSR_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ signedCertificateChain: TEST_CERTIFICATE_PEM }),
    },
  ),
  s(
    'POST',
    '/pnc/csr-requests/:id/reject',
    'certificates:write',
    // A second pending CSR: the sign control consumes the first.
    (f) => `/pnc/csr-requests/${String(f.csr2)}/reject`,
    'CSR_NOT_FOUND',
    { unsited: true, body: () => ({}) },
  ),
  l('/pnc/station-certificates', 'certificates:read', undefined, { unsited: true }),

  // pricing (writes and audit are company-wide)
  c(
    'POST',
    '/pricing-groups',
    'pricing:write',
    () => '/pricing-groups',
    'PRICING_GROUP_NOT_FOUND',
    {
      body: () => ({ name: 'New group' }),
    },
  ),
  c(
    'PATCH',
    '/pricing-groups/:id',
    'pricing:write',
    (_f, w) => `/pricing-groups/${w.pricingGroup}`,
    'PRICING_GROUP_NOT_FOUND',
    {
      body: () => ({ name: 'Renamed' }),
    },
  ),
  c(
    'DELETE',
    '/pricing-groups/:id',
    'pricing:write',
    (_f, w) => `/pricing-groups/${w.pricingGroup}`,
    'PRICING_GROUP_NOT_FOUND',
  ),
  c(
    'POST',
    '/pricing-groups/:id/tariffs',
    'pricing:write',
    (_f, w) => `/pricing-groups/${w.pricingGroup}/tariffs`,
    'TARIFF_NOT_FOUND',
    {
      body: () => ({
        name: 'Weekend night',
        restrictions: { daysOfWeek: [6], timeRange: { startTime: '00:00', endTime: '06:00' } },
      }),
    },
  ),
  c(
    'PATCH',
    '/pricing-groups/:id/tariffs/:tariffId',
    'pricing:write',
    (_f, w) => `/pricing-groups/${w.pricingGroup}/tariffs/${w.tariff}`,
    'TARIFF_NOT_FOUND',
    { body: () => ({}) },
  ),
  c(
    'DELETE',
    '/pricing-groups/:id/tariffs/:tariffId',
    'pricing:write',
    (_f, w) => `/pricing-groups/${w.pricingGroup}/tariffs/${w.tariff}`,
    'TARIFF_NOT_FOUND',
  ),
  c('GET', '/pricing-audit', 'pricing:read', () => '/pricing-audit', 'PRICING_NOT_FOUND'),
  s(
    'GET',
    '/stations/:id/active-tariff',
    'pricing:read',
    (f) => `${st(f)}/active-tariff`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),

  // reports
  l('/reports', 'reports:read'),
  s('GET', '/reports/:id', 'reports:read', (f) => `/reports/${f.report}`, 'REPORT_NOT_FOUND'),
  s(
    'GET',
    '/reports/:id/download',
    'reports:read',
    (f) => `/reports/${f.report}/download`,
    'REPORT_NOT_FOUND',
  ),
  s('POST', '/reports/generate', 'reports:write', () => '/reports/generate', 'SITE_NOT_FOUND', {
    body: (f) => ({
      name: 'Foreign',
      reportType: 'sessions',
      format: 'csv',
      filters: { siteId: f.site },
    }),
  }),
  s('DELETE', '/reports/:id', 'reports:write', (f) => `/reports/${f.report}`, 'REPORT_NOT_FOUND'),
  l('/report-schedules', 'reports:read'),
  s('POST', '/report-schedules', 'reports:write', () => '/report-schedules', 'SITE_NOT_FOUND', {
    body: (f) => ({
      name: 'Foreign',
      reportType: 'sessions',
      format: 'csv',
      frequency: 'daily',
      filters: { siteId: f.site },
    }),
  }),
  s(
    'PATCH',
    '/report-schedules/:id',
    'reports:write',
    (f) => `/report-schedules/${f.schedule}`,
    'SCHEDULE_NOT_FOUND',
    {
      body: () => ({ recipientEmails: ['attacker@example.com'] }),
    },
  ),
  s(
    'DELETE',
    '/report-schedules/:id',
    'reports:write',
    (f) => `/report-schedules/${f.schedule}`,
    'SCHEDULE_NOT_FOUND',
  ),
  s(
    'POST',
    '/report-schedules/:id/run-now',
    'reports:write',
    (f) => `/report-schedules/${f.schedule}/run-now`,
    'SCHEDULE_NOT_FOUND',
    { body: () => ({}) },
  ),

  // reservations
  l('/reservations', 'reservations:read', undefined, { unsited: true }),
  s(
    'GET',
    '/reservations/:id',
    'reservations:read',
    (f) => `/reservations/${f.reservation}`,
    'RESERVATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/reservations/:id/audit',
    'reservations:read',
    (f) => `/reservations/${f.reservation}/audit`,
    'RESERVATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'GET',
    '/reservations/:id/commands',
    'reservations:read',
    (f) => `/reservations/${f.reservation}/commands`,
    'RESERVATION_NOT_FOUND',
    { unsited: true },
  ),
  s('POST', '/reservations', 'reservations:write', () => '/reservations', 'STATION_NOT_FOUND', {
    unsited: true,
    body: (f) => ({ stationId: f.ocpp, expiresAt: iso(2) }),
    control: ctl(400, 'STATION_OFFLINE', OFFLINE),
  }),
  s(
    'PATCH',
    '/reservations/:id',
    'reservations:write',
    (f) => `/reservations/${f.reservation}`,
    'RESERVATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ expiresAt: iso(3) }),
      control: ctl(
        409,
        'RESERVATION_CONFLICT',
        'station A also holds the seeded fleet reservation',
      ),
    },
  ),
  s(
    'DELETE',
    '/reservations/:id',
    'reservations:write',
    (f) => `/reservations/${f.reservation}`,
    'RESERVATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'POST',
    '/reservations/:id/reassign',
    'reservations:write',
    (f) => `/reservations/${f.reservation}/reassign`,
    'RESERVATION_NOT_FOUND',
    {
      unsited: true,
      body: (_f, w) => ({ newStationOcppId: w.A.ocpp }),
      control: ctl(400, 'STATION_OFFLINE', OFFLINE),
      mixed: [
        {
          url: (a) => `/reservations/${a.reservation}/reassign`,
          body: (_a, f) => ({ newStationOcppId: f.ocpp }),
          code: 'STATION_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'GET',
    '/reservations/:id/neighbors',
    'reservations:read',
    (f) => `/reservations/${f.reservation}/neighbors`,
    'RESERVATION_NOT_FOUND',
    { unsited: true },
  ),

  // sessions and transactions
  l('/sessions', 'sessions:read', undefined, { unsited: true }),
  s('GET', '/sessions/:id', 'sessions:read', (f) => `/sessions/${f.session}`, 'SESSION_NOT_FOUND', {
    unsited: true,
  }),
  s(
    'GET',
    '/sessions/:id/transaction-events',
    'sessions:read',
    (f) => `/sessions/${f.session}/transaction-events`,
    'SESSION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'GET',
    '/sessions/:id/meter-values',
    'sessions:read',
    (f) => `/sessions/${f.session}/meter-values`,
    'SESSION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'POST',
    '/sessions/:id/rebill',
    'payments:write',
    (f) => `/sessions/${f.session}/rebill`,
    'SESSION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(
        409,
        'SESSION_REBILL_NOT_ELIGIBLE',
        'the seeded session is not eligible for re-billing',
      ),
    },
  ),
  s(
    'GET',
    '/sessions/:id/neighbors',
    'sessions:read',
    (f) => `/sessions/${f.session}/neighbors`,
    'SESSION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  l('/transactions', 'sessions:read', undefined, { unsited: true }),
  s(
    'GET',
    '/transactions/by-session/:sessionId',
    'sessions:read',
    (f) => `/transactions/by-session/${f.session}`,
    'SESSION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'GET',
    '/transactions/by-transaction-id/:transactionId',
    'sessions:read',
    (f) => `/transactions/by-transaction-id/${f.transactionId}?stationId=${f.ocpp}`,
    'TRANSACTION_NOT_FOUND',
    { unsited: true },
  ),

  // sites
  l('/sites', 'sites:read'),
  l('/sites/filter-options', 'sites:read', undefined, {
    counts: [{ path: 'locations.length', all: 2, a: 1 }],
  }),
  l('/sites/export', 'sites:read'),
  // A 200 with per-row errors: the refused row names the station, nothing else.
  s('POST', '/sites/import', 'sites:write', () => '/sites/import', '', {
    unsited: true,
    status: 200,
    body: (f, w) => ({
      rows: [{ siteName: w.A.siteName, stationId: f.ocpp, evseId: 2, connectorId: 1 }],
      updateExisting: true,
    }),
    expectText: (f) => `station "${f.ocpp}" cannot be imported`,
    noSitesText: (_f, w) => `no access to site "${w.A.siteName}"`,
  }),
  s('GET', '/sites/:id', 'sites:read', (f) => sit(f), 'SITE_NOT_FOUND'),
  c('POST', '/sites', 'sites:write', () => '/sites', 'SITE_NOT_FOUND', {
    body: () => ({ name: 'Created by matrix' }),
  }),
  s('PATCH', '/sites/:id', 'sites:write', (f) => sit(f), 'SITE_NOT_FOUND', {
    body: () => ({ name: 'Renamed' }),
  }),
  s('DELETE', '/sites/:id', 'sites:write', (f) => sit(f), 'SITE_NOT_FOUND', {
    control: ctl(409, 'SITE_HAS_STATIONS', 'the controls create stations in site A'),
  }),
  s('GET', '/sites/:id/metrics', 'sites:read', (f) => `${sit(f)}/metrics`, 'SITE_NOT_FOUND'),
  s('GET', '/sites/:id/stations', 'sites:read', (f) => `${sit(f)}/stations`, 'SITE_NOT_FOUND'),
  s(
    'GET',
    '/sites/:id/energy-history',
    'sites:read',
    (f) => `${sit(f)}/energy-history`,
    'SITE_NOT_FOUND',
  ),
  s(
    'GET',
    '/sites/:id/revenue-history',
    'sites:read',
    (f) => `${sit(f)}/revenue-history`,
    'SITE_NOT_FOUND',
  ),
  s(
    'GET',
    '/sites/:id/popular-times',
    'sites:read',
    (f) => `${sit(f)}/popular-times`,
    'SITE_NOT_FOUND',
  ),
  s(
    'GET',
    '/sites/:id/meter-values',
    'sites:read',
    (f) => `${sit(f)}/meter-values`,
    'SITE_NOT_FOUND',
  ),
  s('GET', '/sites/:id/sessions', 'sites:read', (f) => `${sit(f)}/sessions`, 'SITE_NOT_FOUND'),
  s('GET', '/sites/:id/layout', 'sites:read', (f) => `${sit(f)}/layout`, 'SITE_NOT_FOUND'),
  s('PUT', '/sites/:id/layout', 'sites:write', (f) => `${sit(f)}/layout`, 'SITE_NOT_FOUND', {
    body: (f) => ({ positions: [{ stationId: f.station, positionX: 1, positionY: 1 }] }),
    mixed: [
      {
        url: (a) => `/sites/${a.site}/layout`,
        body: (_a, f) => ({ positions: [{ stationId: f.station, positionX: 1, positionY: 1 }] }),
        code: 'STATION_NOT_FOUND',
      },
    ],
  }),
  s(
    'GET',
    '/sites/:id/pricing-groups',
    'sites:read',
    (f) => `${sit(f)}/pricing-groups`,
    'SITE_NOT_FOUND',
  ),
  s(
    'POST',
    '/sites/:id/pricing-groups',
    'sites:write',
    (f) => `${sit(f)}/pricing-groups`,
    'SITE_NOT_FOUND',
    {
      body: (_f, w) => ({ pricingGroupId: w.pricingGroup }),
    },
  ),
  s(
    'DELETE',
    '/sites/:id/pricing-groups/:pricingGroupId',
    'sites:write',
    (f, w) => `${sit(f)}/pricing-groups/${w.pricingGroup}`,
    'SITE_NOT_FOUND',
  ),
  s('POST', '/sites/:id/free-vend', 'sites:write', (f) => `${sit(f)}/free-vend`, 'SITE_NOT_FOUND', {
    body: () => ({ enabled: true }),
  }),
  s(
    'GET',
    '/sites/:id/carbon-region',
    'sites:read',
    (f) => `${sit(f)}/carbon-region`,
    'SITE_NOT_FOUND',
  ),
  s(
    'PUT',
    '/sites/:id/carbon-region',
    'sites:write',
    (f) => `${sit(f)}/carbon-region`,
    'SITE_NOT_FOUND',
    {
      body: () => ({ regionCode: 'ERCT' }),
    },
  ),
  s(
    'GET',
    '/sites/:id/electricity-rates',
    'sites:read',
    (f) => `${sit(f)}/electricity-rates`,
    'SITE_NOT_FOUND',
  ),
  s(
    'POST',
    '/sites/:id/electricity-rates',
    'sites:write',
    (f) => `${sit(f)}/electricity-rates`,
    'SITE_NOT_FOUND',
    {
      body: () => ({ name: 'Peak', ratePerKwh: 0.3 }),
    },
  ),
  s(
    'PATCH',
    '/sites/:id/electricity-rates/:periodId',
    'sites:write',
    (f) => `${sit(f)}/electricity-rates/${String(f.ratePeriod)}`,
    'ELECTRICITY_RATE_NOT_FOUND',
    {
      body: () => ({ name: 'Peak', ratePerKwh: 0.4 }),
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/electricity-rates/${String(f.ratePeriod)}`,
          body: () => ({ name: 'Peak', ratePerKwh: 0.4 }),
          code: 'ELECTRICITY_RATE_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'DELETE',
    '/sites/:id/electricity-rates/:periodId',
    'sites:write',
    (f) => `${sit(f)}/electricity-rates/${String(f.ratePeriod)}`,
    'ELECTRICITY_RATE_NOT_FOUND',
    {
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/electricity-rates/${String(f.ratePeriod)}`,
          code: 'ELECTRICITY_RATE_NOT_FOUND',
        },
      ],
    },
  ),
  s('GET', '/sites/:id/neighbors', 'sites:read', (f) => `${sit(f)}/neighbors`, 'SITE_NOT_FOUND'),

  // smart charging
  l('/smart-charging/filter-options', 'smartCharging:read'),
  l('/smart-charging/templates', 'smartCharging:read'),
  s(
    'GET',
    '/smart-charging/templates/:id',
    'smartCharging:read',
    (f) => `/smart-charging/templates/${f.profileTemplate}`,
    'TEMPLATE_NOT_FOUND',
  ),
  s(
    'POST',
    '/smart-charging/templates',
    'smartCharging:write',
    () => '/smart-charging/templates',
    'SITE_NOT_FOUND',
    {
      body: (f) => ({
        name: 'Foreign profile',
        profilePurpose: 'TxDefaultProfile',
        profileKind: 'Absolute',
        schedulePeriods: [{ startPeriod: 0, limit: 16 }],
        targetFilter: { siteId: f.site },
      }),
    },
  ),
  s(
    'PATCH',
    '/smart-charging/templates/:id',
    'smartCharging:write',
    (f) => `/smart-charging/templates/${f.profileTemplate}`,
    'TEMPLATE_NOT_FOUND',
    { body: () => ({ name: 'Renamed' }) },
  ),
  s(
    'POST',
    '/smart-charging/templates/:id/duplicate',
    'smartCharging:write',
    (f) => `/smart-charging/templates/${f.profileTemplate}/duplicate`,
    'TEMPLATE_NOT_FOUND',
    { body: () => ({}) },
  ),
  s(
    'DELETE',
    '/smart-charging/templates/:id',
    'smartCharging:write',
    (f) => `/smart-charging/templates/${f.profileTemplate}`,
    'TEMPLATE_NOT_FOUND',
  ),
  s(
    'GET',
    '/smart-charging/templates/:id/matching-stations',
    'smartCharging:read',
    (f) => `/smart-charging/templates/${f.profileTemplate}/matching-stations`,
    'TEMPLATE_NOT_FOUND',
  ),
  s(
    'POST',
    '/smart-charging/templates/:id/push',
    'smartCharging:write',
    (f) => `/smart-charging/templates/${f.profileTemplate}/push`,
    'TEMPLATE_NOT_FOUND',
    { body: () => ({}) },
  ),
  s(
    'POST',
    '/smart-charging/templates/:id/clear',
    'smartCharging:write',
    (f) => `/smart-charging/templates/${f.profileTemplate}/clear`,
    'TEMPLATE_NOT_FOUND',
    { body: () => ({}) },
  ),
  s(
    'GET',
    '/smart-charging/templates/:id/pushes',
    'smartCharging:read',
    (f) => `/smart-charging/templates/${f.profileTemplate}/pushes`,
    'TEMPLATE_NOT_FOUND',
  ),
  s(
    'GET',
    '/smart-charging/templates/:id/neighbors',
    'smartCharging:read',
    (f) => `/smart-charging/templates/${f.profileTemplate}/neighbors`,
    'TEMPLATE_NOT_FOUND',
  ),
  s(
    'GET',
    '/smart-charging/pushes/:pushId',
    'smartCharging:read',
    (f) => `/smart-charging/pushes/${f.profilePush}`,
    'PUSH_NOT_FOUND',
  ),

  // station images
  s('GET', '/stations/:id/images', 'stations:read', (f) => `${st(f)}/images`, 'STATION_NOT_FOUND', {
    unsited: true,
  }),
  s(
    'POST',
    '/stations/:id/images/upload-url',
    'stations:write',
    (f) => `${st(f)}/images/upload-url`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ fileName: 'a.png', contentType: 'image/png', fileSize: 10 }),
      control: ctl(400, 'STORAGE_NOT_CONFIGURED', NO_S3),
    },
  ),
  s(
    'POST',
    '/stations/:id/images',
    'stations:write',
    (f) => `${st(f)}/images`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (f) => ({
        fileName: 'a.png',
        fileSize: 10,
        contentType: 'image/png',
        s3Key: `stations/${f.station}/a.png`,
        s3Bucket: 'bucket',
      }),
      // The confirm route checks the configured bucket after the site check.
      control: ctl(400, 'STORAGE_NOT_CONFIGURED', NO_S3),
    },
  ),
  s(
    'PATCH',
    '/stations/:id/images/:imageId',
    'stations:write',
    (f) => `${st(f)}/images/${String(f.image)}`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ caption: 'Changed' }),
      mixed: [
        {
          url: (a, f) => `/stations/${a.station}/images/${String(f.image)}`,
          body: () => ({ caption: 'Changed' }),
          code: 'IMAGE_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'DELETE',
    '/stations/:id/images/:imageId',
    'stations:write',
    (f) => `${st(f)}/images/${String(f.image)}`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      mixed: [
        {
          url: (a, f) => `/stations/${a.station}/images/${String(f.image)}`,
          code: 'IMAGE_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'GET',
    '/stations/:id/images/:imageId/download-url',
    'stations:read',
    (f) =>
      // No S3 in the test database: the admin gets STORAGE_NOT_CONFIGURED.
      `${st(f)}/images/${String(f.image)}/download-url`,
    'STATION_NOT_FOUND',
    { unsited: true, adminStatus: 400 },
  ),
  s(
    'PATCH',
    '/stations/:id/images/reorder',
    'stations:write',
    (f) => `${st(f)}/images/reorder`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (f) => ({ imageIds: [f.image] }),
      mixed: [
        {
          url: (a) => `/stations/${a.station}/images/reorder`,
          body: (a, f) => ({ imageIds: [a.image, f.image] }),
          status: 200,
        },
      ],
    },
  ),
  s(
    'POST',
    '/stations/:id/images/:imageId/set-main',
    'stations:write',
    (f) => `${st(f)}/images/${String(f.image)}/set-main`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      mixed: [
        {
          url: (a, f) => `/stations/${a.station}/images/${String(f.image)}/set-main`,
          body: () => ({}),
          code: 'IMAGE_NOT_FOUND',
        },
      ],
    },
  ),

  // station message templates (company-wide writes)
  c(
    'PUT',
    '/station-message-templates/:state',
    'settings.integrations:write',
    () => '/station-message-templates/available?language=en',
    'TEMPLATE_NOT_FOUND',
    { body: () => ({ body: 'Hi' }) },
  ),
  c(
    'DELETE',
    '/station-message-templates/:state',
    'settings.integrations:write',
    () => '/station-message-templates/available?language=en',
    'TEMPLATE_NOT_FOUND',
  ),

  // station web payments
  s(
    'GET',
    '/stations/:id/web-payments',
    'stations:read',
    (f) => `${st(f)}/web-payments`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/web-payments/support',
    'stations:read',
    (f) => `${st(f)}/web-payments/support`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'PUT',
    '/stations/:id/web-payments',
    'stations:write',
    (f) => `${st(f)}/web-payments`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(409, 'STATION_OFFLINE', OFFLINE),
    },
  ),
  s(
    'DELETE',
    '/stations/:id/web-payments',
    'stations:write',
    (f) => `${st(f)}/web-payments`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),

  // stations
  l('/stations', 'stations:read', undefined, { unsited: true }),
  s('GET', '/stations/:id', 'stations:read', st, 'STATION_NOT_FOUND', { unsited: true }),
  s(
    'POST',
    '/stations/:id/configurations/refresh',
    'stations:write',
    (f) => `${st(f)}/configurations/refresh`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}), control: ctl(400, 'STATION_OFFLINE', OFFLINE) },
  ),
  s('POST', '/stations', 'stations:write', () => '/stations', 'SITE_NOT_FOUND', {
    body: (f) => ({ stationId: 'MATRIX-NEW', siteId: f.site }),
  }),
  s('PATCH', '/stations/:id', 'stations:write', st, 'STATION_NOT_FOUND', {
    unsited: true,
    body: () => ({ model: 'Renamed' }),
  }),
  s('DELETE', '/stations/:id', 'stations:write', st, 'STATION_NOT_FOUND', { unsited: true }),
  s(
    'GET',
    '/stations/:id/connectors',
    'stations:read',
    (f) => `${st(f)}/connectors`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s('POST', '/stations/:id/evses', 'stations:write', (f) => `${st(f)}/evses`, 'STATION_NOT_FOUND', {
    unsited: true,
    body: () => ({
      evseId: 9,
      connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 50 }],
    }),
  }),
  s(
    'PATCH',
    '/stations/:id/evses/:evseId',
    'stations:write',
    (f) => `${st(f)}/evses/${String(f.evse)}`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({ connectors: [] }) },
  ),
  s(
    'POST',
    '/stations/:id/evses/:evseId/refresh-status',
    'stations:read',
    (f) => `${st(f)}/evses/${String(f.evse)}/refresh-status`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}), control: ctl(400, 'STATION_OFFLINE', OFFLINE) },
  ),
  s(
    'POST',
    '/stations/:id/evses/:evseId/stop-active-session',
    'stations:write',
    (f) => `${st(f)}/evses/${String(f.evse)}/stop-active-session`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(404, 'NO_ACTIVE_SESSION', 'the seeded sessions are completed'),
    },
  ),
  s(
    'POST',
    '/stations/:id/evses/:evseId/connectors',
    'stations:write',
    (f) => `${st(f)}/evses/${String(f.evse)}/connectors`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ connectorId: 5, connectorType: 'CCS2', maxPowerKw: 50 }),
    },
  ),
  s(
    'DELETE',
    '/stations/:id/evses/:evseId',
    'stations:write',
    (f) => `${st(f)}/evses/${String(f.evse)}`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'DELETE',
    '/stations/:id/evses/:evseId/connectors/:connectorId',
    'stations:write',
    (f) => `${st(f)}/evses/${String(f.evse)}/connectors/${String(f.connector)}`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'GET',
    '/stations/:id/meter-values',
    'stations:read',
    (f) => `${st(f)}/meter-values`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/energy-history',
    'stations:read',
    (f) => `${st(f)}/energy-history`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/revenue-history',
    'stations:read',
    (f) => `${st(f)}/revenue-history`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/uptime-history',
    'stations:read',
    (f) => `${st(f)}/uptime-history`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/popular-times',
    'stations:read',
    (f) => `${st(f)}/popular-times`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/metrics',
    'stations:read',
    (f) => `${st(f)}/metrics`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'GET',
    '/stations/:id/sessions',
    'stations:read',
    (f) => `${st(f)}/sessions`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/ocpp-logs',
    'stations:read',
    (f) => `${st(f)}/ocpp-logs`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'POST',
    '/stations/:id/credentials',
    'stations:write',
    (f) => `${st(f)}/credentials`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ password: 'Abcdefghijklmnop1234' }),
    },
  ),
  s(
    'POST',
    '/stations/:id/rotate-credentials',
    'stations:write',
    (f) => `${st(f)}/rotate-credentials`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}), control: ctl(409, 'STATION_OFFLINE', OFFLINE) },
  ),
  s(
    'POST',
    '/stations/:id/confirm-real-station',
    'stations:write',
    (f) => `${st(f)}/confirm-real-station`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}) },
  ),
  s(
    'GET',
    '/stations/:id/security-logs',
    'stations:read',
    (f) => `${st(f)}/security-logs`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/certificates',
    'stations:read',
    (f) => `${st(f)}/certificates`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'POST',
    '/stations/:id/certificates/install',
    'stations:write',
    (f) => `${st(f)}/certificates/install`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ certificateType: 'V2GRootCertificate', certificate: TEST_CERTIFICATE_PEM }),
    },
  ),
  s(
    'POST',
    '/stations/:id/certificates/delete',
    'stations:write',
    (f) => `${st(f)}/certificates/delete`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'a',
          issuerKeyHash: 'b',
          serialNumber: 'c',
        },
      }),
    },
  ),
  s(
    'POST',
    '/stations/:id/certificates/query',
    'stations:write',
    (f) => `${st(f)}/certificates/query`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}) },
  ),
  s(
    'GET',
    '/stations/:id/pricing-groups',
    'stations:read',
    (f) => `${st(f)}/pricing-groups`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'POST',
    '/stations/:id/pricing-groups',
    'stations:write',
    (f) => `${st(f)}/pricing-groups`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (_f, w) => ({ pricingGroupId: w.pricingGroup }),
    },
  ),
  s(
    'DELETE',
    '/stations/:id/pricing-groups/:pricingGroupId',
    'stations:write',
    (f, w) => `${st(f)}/pricing-groups/${w.pricingGroup}`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'POST',
    '/stations/:id/approve',
    'stations:write',
    (f) => `${st(f)}/approve`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(409, 'NOT_PENDING', 'the seeded station is accepted'),
    },
  ),
  s(
    'POST',
    '/stations/:id/unblock',
    'stations:write',
    (f) => `${st(f)}/unblock`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(409, 'NOT_BLOCKED', 'the seeded station is accepted'),
    },
  ),
  s(
    'POST',
    '/stations/:id/reject',
    'stations:write',
    (f) => `${st(f)}/reject`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(409, 'NOT_PENDING', 'the seeded station is accepted'),
    },
  ),
  s(
    'GET',
    '/stations/:id/security-events',
    'stations:read',
    (f) => `${st(f)}/security-events`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s('GET', '/stations/:id/events', 'stations:read', (f) => `${st(f)}/events`, 'STATION_NOT_FOUND', {
    unsited: true,
  }),
  s(
    'GET',
    '/stations/:id/variables',
    'stations:read',
    (f) => `${st(f)}/variables`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/firmware-history',
    'stations:read',
    (f) => `${st(f)}/firmware-history`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/charging-profiles',
    'stations:read',
    (f) => `${st(f)}/charging-profiles`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'POST',
    '/stations/:id/charging-profiles/refresh',
    'stations:write',
    (f) => `${st(f)}/charging-profiles/refresh`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}), control: ctl(400, 'STATION_OFFLINE', OFFLINE) },
  ),
  s(
    'POST',
    '/stations/:id/charging-profiles/composite',
    'stations:write',
    (f) => `${st(f)}/charging-profiles/composite`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}), control: ctl(400, 'STATION_OFFLINE', OFFLINE) },
  ),
  s(
    'POST',
    '/stations/:id/charging-profiles/clear',
    'stations:write',
    (f) => `${st(f)}/charging-profiles/clear`,
    'STATION_NOT_FOUND',
    { unsited: true, body: () => ({}), control: ctl(400, 'STATION_OFFLINE', OFFLINE) },
  ),
  s(
    'POST',
    '/stations/:id/charging-profiles/push',
    'stations:write',
    (f) => `${st(f)}/charging-profiles/push`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (_f, w) => ({ templateId: w.A.profileTemplate }),
      control: ctl(400, 'STATION_OFFLINE', OFFLINE),
    },
  ),
  s(
    'POST',
    '/stations/:id/configurations/push',
    'stations:write',
    (f) => `${st(f)}/configurations/push`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: (_f, w) => ({ templateId: w.A.configTemplate }),
      control: ctl(400, 'STATION_OFFLINE', OFFLINE),
    },
  ),
  s(
    'GET',
    '/stations/:id/ev-charging-needs',
    'stations:read',
    (f) => `${st(f)}/ev-charging-needs`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'GET',
    '/stations/:id/monitoring-rules',
    'stations:read',
    (f) => `${st(f)}/monitoring-rules`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'POST',
    '/stations/:id/monitoring-rules',
    'stations:write',
    (f) => `${st(f)}/monitoring-rules`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ component: 'EVSE', variable: 'Power', type: 'UpperThreshold', value: 10 }),
    },
  ),
  s(
    'DELETE',
    '/stations/:id/monitoring-rules/:ruleId',
    'stations:write',
    (f) => `${st(f)}/monitoring-rules/${String(f.monitor)}`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      mixed: [
        {
          url: (a, f) => `/stations/${a.station}/monitoring-rules/${String(f.monitor)}`,
          code: 'RULE_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'GET',
    '/stations/:id/event-alerts',
    'stations:read',
    (f) => `${st(f)}/event-alerts`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),
  s(
    'POST',
    '/stations/:id/event-alerts/:alertId/acknowledge',
    'stations:write',
    (f) => `${st(f)}/event-alerts/${String(f.alert)}/acknowledge`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      mixed: [
        {
          url: (a, f) => `/stations/${a.station}/event-alerts/${String(f.alert)}/acknowledge`,
          body: () => ({}),
          code: 'ALERT_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'GET',
    '/stations/:id/standalone-meter-values',
    'stations:read',
    (f) => `${st(f)}/standalone-meter-values`,
    'STATION_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'GET',
    '/stations/:id/neighbors',
    'stations:read',
    (f) => `${st(f)}/neighbors`,
    'STATION_NOT_FOUND',
    {
      unsited: true,
    },
  ),

  // support cases
  l('/support-cases', 'support:read', undefined, { unsited: true }),
  l('/support-cases/unread-count', 'support:read', undefined, {
    provenBy: 'counts unread support cases only at the user sites',
  }),
  s(
    'GET',
    '/support-cases/:id',
    'support:read',
    (f) => `/support-cases/${f.supportCase}`,
    'SUPPORT_CASE_NOT_FOUND',
    { unsited: true },
  ),
  s(
    'POST',
    '/support-cases/:id/read',
    'support:write',
    (f) => `/support-cases/${f.supportCase}/read`,
    'SUPPORT_CASE_NOT_FOUND',
    { unsited: true, body: () => ({}) },
  ),
  s('POST', '/support-cases', 'support:write', () => '/support-cases', 'STATION_NOT_FOUND', {
    unsited: true,
    body: (f) => ({
      subject: 'S',
      description: 'D',
      category: 'charging_failure',
      stationId: f.station,
    }),
  }),
  s(
    'PATCH',
    '/support-cases/:id',
    'support:write',
    (f) => `/support-cases/${f.supportCase}`,
    'SUPPORT_CASE_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ subject: 'Changed' }),
    },
  ),
  s(
    'POST',
    '/support-cases/:id/messages',
    'support:write',
    (f) => `/support-cases/${f.supportCase}/messages`,
    'SUPPORT_CASE_NOT_FOUND',
    { unsited: true, body: () => ({ body: 'Hello' }) },
  ),
  s(
    'POST',
    '/support-cases/:id/messages/:messageId/attachments/upload-url',
    'support:write',
    (f) => `/support-cases/${f.supportCase}/messages/${String(f.message)}/attachments/upload-url`,
    'SUPPORT_CASE_NOT_FOUND',
    {
      unsited: true,
      body: () => ({ fileName: 'a.txt', contentType: 'text/plain', fileSize: 10 }),
      control: ctl(400, 'STORAGE_NOT_CONFIGURED', NO_S3),
    },
  ),
  s(
    'POST',
    '/support-cases/:id/messages/:messageId/attachments',
    'support:write',
    (f) => `/support-cases/${f.supportCase}/messages/${String(f.message)}/attachments`,
    'SUPPORT_CASE_NOT_FOUND',
    {
      unsited: true,
      body: () => ({
        fileName: 'a.txt',
        fileSize: 10,
        contentType: 'text/plain',
        s3Key: 'k',
        s3Bucket: 'b',
      }),
      control: ctl(
        400,
        'VALIDATION_ERROR',
        'without S3 no upload URL was issued for the attachment',
      ),
      mixed: [
        {
          url: (a, f) =>
            `/support-cases/${a.supportCase}/messages/${String(f.message)}/attachments`,
          body: () => ({
            fileName: 'a.txt',
            fileSize: 10,
            contentType: 'text/plain',
            s3Key: 'k',
            s3Bucket: 'b',
          }),
          code: 'MESSAGE_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'GET',
    '/support-cases/:id/messages/:messageId/attachments/:attachmentId/download-url',
    'support:read',
    (f) =>
      `/support-cases/${f.supportCase}/messages/${String(f.message)}/attachments/${String(f.attachment)}/download-url`,
    'SUPPORT_CASE_NOT_FOUND',
    {
      unsited: true,
      adminStatus: 400,
      mixed: [
        {
          url: (a, f) =>
            `/support-cases/${a.supportCase}/messages/${String(a.message)}/attachments/${String(f.attachment)}/download-url`,
          code: 'ATTACHMENT_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'DELETE',
    '/support-cases/:id/messages/:messageId/attachments/:attachmentId',
    'support:write',
    (f) =>
      `/support-cases/${f.supportCase}/messages/${String(f.message)}/attachments/${String(f.attachment)}`,
    'SUPPORT_CASE_NOT_FOUND',
    {
      unsited: true,
      mixed: [
        {
          url: (a, f) =>
            `/support-cases/${a.supportCase}/messages/${String(f.message)}/attachments/${String(f.attachment)}`,
          code: 'ATTACHMENT_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'POST',
    '/support-cases/:id/refund',
    'support:write',
    (f) => `/support-cases/${f.supportCase}/refund`,
    'SUPPORT_CASE_NOT_FOUND',
    {
      unsited: true,
      body: (f) => ({ sessionId: f.session }),
      control: ctl(400, 'MISSING_PAYMENT_INTENT', NO_PROVIDER_PAYMENT),
      mixed: [
        {
          url: (a) => `/support-cases/${a.supportCase}/refund`,
          body: (_a, f) => ({ sessionId: f.session }),
          status: 400,
          code: 'SESSION_NOT_LINKED',
        },
      ],
    },
  ),
  s(
    'POST',
    '/support-cases/:id/ai-assist',
    'support:write',
    (f) => `/support-cases/${f.supportCase}/ai-assist`,
    'CASE_NOT_FOUND',
    {
      unsited: true,
      body: () => ({}),
      control: ctl(
        400,
        'SUPPORT_AI_NOT_CONFIGURED',
        'no support AI is configured in the test database',
      ),
    },
  ),
  s(
    'GET',
    '/support-cases/:id/neighbors',
    'support:read',
    (f) => `/support-cases/${f.supportCase}/neighbors`,
    'SUPPORT_CASE_NOT_FOUND',
    { unsited: true },
  ),

  // tokens: the token is company-wide, its sessions are per site
  l('/tokens/:id/sessions', 'drivers:read', (_f, w) => `/tokens/${w.token}/sessions`, {
    unsited: true,
  }),

  // unmanaged loads
  s(
    'POST',
    '/sites/:siteId/unmanaged-loads',
    'loadManagement:write',
    (f) => `${sit(f)}/unmanaged-loads`,
    'SITE_NOT_FOUND',
    {
      body: (f) => ({ name: 'Load X', estimatedDrawKw: 1, panelId: f.panel }),
      mixed: [
        {
          url: (a) => `/sites/${a.site}/unmanaged-loads`,
          body: (_a, f) => ({ name: 'Load X', estimatedDrawKw: 1, panelId: f.panel }),
          status: 400,
          code: 'INVALID_PANEL',
        },
      ],
    },
  ),
  s(
    'GET',
    '/sites/:siteId/unmanaged-loads',
    'loadManagement:read',
    (f) => `${sit(f)}/unmanaged-loads`,
    'SITE_NOT_FOUND',
  ),
  s(
    'PATCH',
    '/sites/:siteId/unmanaged-loads/:id',
    'loadManagement:write',
    (f) => `${sit(f)}/unmanaged-loads/${f.load}`,
    'LOAD_NOT_FOUND',
    {
      body: () => ({ name: 'Renamed' }),
      mixed: [
        {
          url: (a, f) => `/sites/${a.site}/unmanaged-loads/${f.load}`,
          body: () => ({ name: 'Renamed' }),
          code: 'LOAD_NOT_FOUND',
        },
      ],
    },
  ),
  s(
    'DELETE',
    '/sites/:siteId/unmanaged-loads/:id',
    'loadManagement:write',
    (f) => `${sit(f)}/unmanaged-loads/${f.load}`,
    'LOAD_NOT_FOUND',
    {
      control: { order: 990 },
      mixed: [
        { url: (a, f) => `/sites/${a.site}/unmanaged-loads/${f.load}`, code: 'LOAD_NOT_FOUND' },
      ],
    },
  ),

  // users (a restricted operator manages only users within its sites)
  l('/users', 'users:read'),
  s('POST', '/users', 'users:write', () => '/users', 'INVALID_SITE_IDS', {
    status: 400,
    body: (f, w) => ({
      email: 'matrix-new@test.com',
      roleId: w.role,
      siteIds: [f.site],
    }),
  }),
  s('GET', '/users/:id', 'users:read', (f) => `/users/${f.user}`, 'USER_NOT_FOUND'),
  s('PATCH', '/users/:id', 'users:write', (f) => `/users/${f.user}`, 'USER_NOT_FOUND', {
    body: () => ({ firstName: 'Changed' }),
  }),
  s(
    'POST',
    '/users/:id/reset-password',
    'users:write',
    (f) => `/users/${f.user}/reset-password`,
    'USER_NOT_FOUND',
    {
      body: () => ({ password: 'NewPassword123!' }),
    },
  ),
  s('DELETE', '/users/:id', 'users:write', (f) => `/users/${f.user}`, 'USER_NOT_FOUND'),
  s(
    'POST',
    '/users/:id/resend-invite',
    'users:write',
    (f) => `/users/${f.user}/resend-invite`,
    'USER_NOT_FOUND',
    {
      body: () => ({}),
    },
  ),
  s(
    'GET',
    '/users/:id/permissions',
    'users:read',
    (f) => `/users/${f.user}/permissions`,
    'USER_NOT_FOUND',
  ),
  s(
    'PUT',
    '/users/:id/permissions',
    'users:write',
    (f) => `/users/${f.user}/permissions`,
    'USER_NOT_FOUND',
    {
      body: () => ({ permissions: [] }),
    },
  ),
  s(
    'GET',
    '/users/:id/neighbors',
    'users:read',
    (f) => `/users/${f.user}/neighbors`,
    'USER_NOT_FOUND',
  ),
  // system, security and SSO settings: all-site access only (REVIEW2 #1, #2)
  // REVIEW2 #2: generic settings hold the payment provider, currency, secrets and SMTP.
  // A restricted user gets only SITE_RESTRICTED_SETTING_KEYS.
  l('/settings', 'settings.system:read', undefined, {
    noLimit: true,
    provenBy: 'keeps settings secrets and company settings from restricted users (REVIEW2 #2)',
  }),
  c(
    'GET',
    '/settings/:key',
    'settings.system:read',
    () => '/settings/smtp.passwordEnc',
    'SETTING_NOT_FOUND',
  ),
  c(
    'PATCH',
    '/settings/:key',
    'settings.system:write',
    () => '/settings/company.currency',
    'SETTING_NOT_FOUND',
    { body: () => ({ value: 'USD' }) },
  ),
  c(
    'PUT',
    '/settings/:key',
    'settings.system:write',
    () => '/settings/company.name',
    'SETTING_NOT_FOUND',
    {
      body: () => ({ value: 'Matrix Company' }),
    },
  ),
  c(
    'DELETE',
    '/settings/:key',
    'settings.system:write',
    () => '/settings/matrix.deletable',
    'SETTING_NOT_FOUND',
  ),
  // Settings > AI is company-wide; the defaults route answers like the AI settings.
  c(
    'GET',
    '/settings/ai/defaults',
    'settings.ai:read',
    () => '/settings/ai/defaults',
    'SETTING_NOT_FOUND',
  ),
  c(
    'GET',
    '/settings/s3/status',
    'settings.system:read',
    () => '/settings/s3/status',
    'SETTING_NOT_FOUND',
  ),
  c('PUT', '/settings/s3', 'settings.system:write', () => '/settings/s3', 'SETTING_NOT_FOUND', {
    body: () => ({
      bucket: 'matrix-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIAMATRIX',
      secretAccessKey: 'matrix-secret',
    }),
    // Last of all: S3 stays unconfigured for the storage controls before it.
    control: { order: 2000 },
  }),
  c(
    'POST',
    '/settings/s3/test',
    'settings.system:write',
    () => '/settings/s3/test',
    'SETTING_NOT_FOUND',
    {
      body: () => ({}),
      control: ctl(400, 'STORAGE_NOT_CONFIGURED', NO_S3),
    },
  ),
  // REVIEW3 #1: the payment provider, integrations, URLs, CORS and rate limits.
  c('GET', '/system/info', 'settings.system:read', () => '/system/info', 'SETTING_NOT_FOUND'),
  // REVIEW3 #3: the response cache is shared by every site.
  c('POST', '/cache/flush', 'settings.system:write', () => '/cache/flush', 'SETTING_NOT_FOUND', {
    control: ctl(500, 'INTERNAL_ERROR', 'the response cache is disabled in tests'),
  }),
  // REVIEW2 #1: SSO and MFA settings decide who signs in.
  c(
    'GET',
    '/security/settings',
    'settings.security:read',
    () => '/security/settings',
    'SETTING_NOT_FOUND',
  ),
  c(
    'PUT',
    '/security/recaptcha',
    'settings.security:write',
    () => '/security/recaptcha',
    'SETTING_NOT_FOUND',
    {
      body: () => ({ enabled: false, siteKey: 'matrix-site-key', threshold: 0.5 }),
    },
  ),
  c('PUT', '/security/mfa', 'settings.security:write', () => '/security/mfa', 'SETTING_NOT_FOUND', {
    body: () => ({ emailEnabled: false, totpEnabled: false, smsEnabled: false }),
  }),
  c('GET', '/sso/settings', 'settings.security:read', () => '/sso/settings', 'SETTING_NOT_FOUND'),
  c('PUT', '/sso/settings', 'settings.security:write', () => '/sso/settings', 'SETTING_NOT_FOUND', {
    body: () => ({
      enabled: false,
      provider: 'custom',
      entryPoint: 'https://idp.example.com/sso',
      issuer: 'evtivity',
      autoProvision: false,
      defaultRoleId: '',
      attributeMapping: {},
    }),
  }),

  // Plug and Charge settings: all-site access only (REVIEW2 #9)
  c(
    'GET',
    '/pnc/settings',
    'settings.integrations:read',
    () => '/pnc/settings',
    'SETTING_NOT_FOUND',
  ),
  c(
    'PUT',
    '/pnc/settings',
    'settings.integrations:write',
    () => '/pnc/settings',
    'SETTING_NOT_FOUND',
    {
      body: () => ({ enabled: true }),
    },
  ),
  c(
    'POST',
    '/pnc/settings/test-provider',
    'settings.integrations:write',
    () => '/pnc/settings/test-provider',
    'SETTING_NOT_FOUND',
    { body: () => ({}) },
  ),
  c(
    'GET',
    '/pnc/settings/local-ca',
    'settings.integrations:read',
    () => '/pnc/settings/local-ca',
    'SETTING_NOT_FOUND',
  ),
  // Plug and Charge trust store writes: all-site access only (REVIEW2 #9)
  c(
    'POST',
    '/pnc/ca-certificates',
    'certificates:write',
    () => '/pnc/ca-certificates',
    'CA_CERT_NOT_FOUND',
    { body: () => ({ certificate: TEST_CERTIFICATE_PEM, certificateType: 'V2GRootCertificate' }) },
  ),
  c(
    'DELETE',
    '/pnc/ca-certificates/:id',
    'certificates:write',
    (_f, w) => `/pnc/ca-certificates/${String(w.caCertificate)}`,
    'CA_CERT_NOT_FOUND',
  ),
  c(
    'POST',
    '/pnc/refresh-root-certificates',
    'certificates:write',
    () => '/pnc/refresh-root-certificates',
    'CA_CERT_NOT_FOUND',
    {
      body: () => ({}),
      control: ctl(
        502,
        'PKI_ROOT_REFRESH_FAILED',
        'no PKI provider is configured in the test database',
      ),
    },
  ),
  c(
    'POST',
    '/pnc/settings/local-ca',
    'settings.integrations:write',
    () => '/pnc/settings/local-ca',
    'SETTING_NOT_FOUND',
    { body: () => ({}) },
  ),

  // fleets: the records are company-wide, their station counts per site (REVIEW2 #15)
  l('/fleets', 'fleets:read', undefined, {
    counts: [{ path: 'data.[name=Fleet 1].stationCount', all: 3, a: 1 }],
  }),
  // REVIEW2 #15: credit and billing profile are company-wide money settings.
  l('/fleets/:id', 'fleets:read', (_f, w) => `/fleets/${w.fleet}`, {
    noLimit: true,
    hidden: [
      'creditLimitCents',
      'creditLimitWarningPercent',
      'billingContactEmails',
      'billingLegalName',
      'billingStreet',
      'billingCity',
      'billingState',
      'billingZip',
      'billingCountry',
      'billingTaxId',
      'invoiceLanguage',
      'paymentTermsDays',
      'autoInvoice',
    ],
  }),
  // REVIEW2 #12: fleet delete, members of a fleet with a pricing group or account
  // billing, and accountBillingOptOut need all-site access (owner decision).
  c('DELETE', '/fleets/:id', 'fleets:write', (_f, w) => `/fleets/${w.fleet}`, 'FLEET_NOT_FOUND', {
    control: { url: (_f, w) => `/fleets/${w.pricedFleet}` },
  }),
  c(
    'POST',
    '/fleets/:id/drivers',
    'fleets:write',
    (_f, w) => `/fleets/${w.pricedFleet}/drivers`,
    'FLEET_NOT_FOUND',
    { body: (_f, w) => ({ driverId: w.driver2 }) },
  ),
  c(
    'PATCH',
    '/fleets/:id/drivers/:driverId',
    'fleets:write',
    (_f, w) => `/fleets/${w.fleet}/drivers/${w.driver}`,
    'FLEET_NOT_FOUND',
    { body: () => ({ accountBillingOptOut: true }) },
  ),
  c(
    'DELETE',
    '/fleets/:id/drivers/:driverId',
    'fleets:write',
    (_f, w) => `/fleets/${w.pricedFleet}/drivers/${w.driver}`,
    'FLEET_NOT_FOUND',
  ),
];

/** Operator routes with no site data, each with the reason. */
export const SITE_ISOLATION_ALLOWLIST: AllowlistEntry[] = [
  ...(
    [
      ['POST', '/access-logs'],
      ['POST', '/portal/access-logs'],
    ] as const
  ).map(([method, path]) => ({ method, path, reason: "records the caller's own page access" })),
  ...(['GET', 'POST', 'PATCH', 'DELETE'] as const).flatMap((method) =>
    (method === 'GET' || method === 'POST' ? ['/api-keys'] : ['/api-keys/:id']).map((path) => ({
      method,
      path,
      reason: "the caller's own API keys",
    })),
  ),
  { method: 'GET', path: '/assistant/status', reason: 'AI availability flag, no site data' },
  ...(
    [
      ['GET', '/assistant/conversations'],
      ['POST', '/assistant/conversations'],
      ['GET', '/assistant/conversations/:id'],
      ['PATCH', '/assistant/conversations/:id'],
      ['DELETE', '/assistant/conversations/:id'],
      ['POST', '/assistant/conversations/:id/messages'],
      // confirm and reject
      ['POST', '/assistant/conversations/:id/actions/:actionId/*'],
    ] as const
  ).map(([method, path]) => ({
    method,
    path,
    reason: "the caller's own AI conversations; their tools call the API as the caller",
  })),
  {
    method: 'POST',
    path: '/assistant/attachments/upload-url',
    reason: 'AI chat attachment of the caller; owner-scoped, no site data',
  },
  {
    method: 'POST',
    path: '/assistant/attachments/:id/confirm',
    reason: 'AI chat attachment of the caller; another user gets 404',
  },
  {
    method: 'GET',
    path: '/assistant/attachments/:id/download-url',
    reason: 'AI chat attachment of the caller; another user gets 404',
  },
  {
    method: 'DELETE',
    path: '/assistant/attachments/:id',
    reason: 'AI chat attachment of the caller; another user gets 404',
  },
  { method: 'GET', path: '/carbon/factors', reason: 'public carbon factor catalog' },
  { method: 'GET', path: '/carbon/factors/:regionCode', reason: 'public carbon factor catalog' },
  ...(
    [
      ['GET', '/drivers'],
      ['GET', '/drivers/:id'],
      ['POST', '/drivers/:id/portal-invite'],
      ['POST', '/drivers'],
      ['PATCH', '/drivers/:id'],
      ['DELETE', '/drivers/:id'],
      ['GET', '/drivers/:id/tokens'],
      ['POST', '/drivers/:id/tokens'],
      ['GET', '/drivers/:id/vehicles'],
      ['GET', '/drivers/:id/vehicles/:vehicleId'],
      ['POST', '/drivers/:id/vehicles'],
      ['PATCH', '/drivers/:id/vehicles/:vehicleId'],
      ['DELETE', '/drivers/:id/vehicles/:vehicleId'],
      ['GET', '/vehicles/lookup'],
      ['GET', '/drivers/:id/pricing-groups'],
      ['GET', '/drivers/:id/neighbors'],
      ['GET', '/drivers/:id/payment-methods'],
      ['POST', '/drivers/:id/payment-methods/setup-intent'],
      ['POST', '/drivers/:id/payment-methods'],
      ['POST', '/drivers/:id/payment-methods/setup/submit'],
      ['POST', '/drivers/:id/payment-methods/setup/details'],
      ['DELETE', '/drivers/:id/payment-methods/:pmId'],
      ['PATCH', '/drivers/:id/payment-methods/:pmId/default'],
      ['GET', '/drivers/:id/pnc-contracts'],
      ['POST', '/drivers/:id/pnc-contracts'],
      ['POST', '/drivers/:id/pnc-contracts/:contractId/revoke'],
    ] as const
  ).map(([method, path]) => ({
    method,
    path,
    reason: 'drivers are company-wide records (owner decision); per-site history is in the matrix',
  })),
  ...(
    [
      ['GET', '/tokens/filter-options'],
      ['GET', '/tokens'],
      ['GET', '/tokens/export'],
      ['POST', '/tokens/import'],
      ['POST', '/tokens/bulk-active'],
      ['GET', '/tokens/:id'],
      ['POST', '/tokens'],
      ['PATCH', '/tokens/:id'],
      ['DELETE', '/tokens/:id'],
      ['GET', '/tokens/:id/neighbors'],
    ] as const
  ).map(([method, path]) => ({
    method,
    path,
    reason: 'driver tokens are company-wide records; token sessions are in the matrix',
  })),
  ...(
    [
      ['POST', '/fleets'],
      ['PATCH', '/fleets/:id'],
      ['GET', '/fleets/:id/drivers'],
      ['GET', '/fleets/:id/vehicles'],
      ['GET', '/fleets/:id/vehicles/available'],
      ['GET', '/fleets/:id/pricing-groups'],
      ['GET', '/fleets/:id/neighbors'],
    ] as const
  ).map(([method, path]) => ({
    method,
    path,
    reason:
      'fleets and their members are company-wide records; fleet stations, counts, history and the all-site-only writes are in the matrix',
  })),
  ...(['GET /event-alert-rules'] as const).map((k) => ({
    method: 'GET' as const,
    path: k.slice(4),
    reason: 'alert rules are company-wide configuration, readable by every operator',
  })),
  {
    method: 'GET',
    path: '/events/stream',
    reason: 'SSE stream, site-filtered per event (events-cov2, 97-site-access-hardening)',
  },
  { method: 'GET', path: '/v1/health', reason: 'health check' },
  { method: 'GET', path: '/v1/version', reason: 'API version' },
  { method: 'GET', path: '/pricing-holidays', reason: 'pricing reads are company-wide' },
  ...(
    [
      '/pricing-groups',
      '/pricing-groups/:id',
      '/pricing/tariffs',
      '/pricing-groups/:id/tariffs',
      '/pricing-groups/:id/tariffs/:tariffId',
      '/pricing-groups/:id/schedule',
      '/pricing-groups/:id/neighbors',
    ] as const
  ).map((path) => ({ method: 'GET' as const, path, reason: 'pricing reads are company-wide' })),
  {
    method: 'POST',
    path: '/maintenance/preview-message',
    reason: 'renders a message preview, no site data',
  },
  ...(
    [
      ['GET', '/ocpp-event-types'],
      ['GET', '/ocpp-event-template'],
      ['GET', '/ocpp-event-settings'],
      ['GET', '/driver-event-settings'],
      ['GET', '/notification-templates'],
      ['POST', '/email-wrapper/preview'],
      ['POST', '/notification-templates/preview'],
      ['GET', '/station-message-templates'],
      ['POST', '/station-message-templates/preview'],
    ] as const
  ).map(([method, path]) => ({
    method,
    path,
    reason: 'notification and message template reads and previews are company-wide configuration',
  })),
  ...(
    [
      ['GET', '/ocpp/schemas/:action'],
      ['GET', '/ocpp/commands/v21/:action/schema'],
      ['GET', '/ocpp/commands/v16/:action/schema'],
    ] as const
  ).map(([method, path]) => ({ method, path, reason: 'OCPP schema catalog' })),
  ...(
    [
      ['GET', '/octt/runs'],
      ['GET', '/octt/runs/:id'],
      ['GET', '/octt/runs/:id/summary'],
      ['GET', '/octt/runs/:id/neighbors'],
    ] as const
  ).map(([method, path]) => ({ method, path, reason: 'conformance results, no site data' })),
  ...([['GET', '/pnc/ca-certificates']] as const).map(([method, path]) => ({
    method,
    path,
    reason: 'Plug and Charge trust store reads: public root certificates, no site data',
  })),
  { method: 'GET', path: '/reports/types', reason: 'report type catalog' },
  { method: 'GET', path: '/security/public', reason: 'public security settings' },
  ...(
    [
      ['GET', '/portal/branding'],
      ['GET', '/portal/features'],
      ['GET', '/portal/content/:type'],
    ] as const
  ).map(([method, path]) => ({ method, path, reason: 'public portal content' })),
  { method: 'GET', path: '/auth/sso/login', reason: 'single sign-on sign-in' },
  { method: 'POST', path: '/auth/sso/callback', reason: 'single sign-on sign-in' },
  { method: 'GET', path: '/sites/export/template', reason: 'empty CSV template' },
  {
    method: 'GET',
    path: '/support-cases/attachment-storage',
    reason: 'storage configuration flag',
  },
  ...(
    [
      ['POST', '/auth/login'],
      ['POST', '/auth/logout'],
      ['POST', '/auth/refresh'],
      ['POST', '/auth/forgot-password'],
      ['POST', '/auth/reset-password'],
      ['POST', '/auth/force-change-password'],
      ['POST', '/auth/mfa/verify'],
      ['POST', '/auth/mfa/resend'],
    ] as const
  ).map(([method, path]) => ({ method, path, reason: 'authentication' })),
  ...(
    [
      ['GET', '/users/me'],
      ['PATCH', '/users/me'],
      ['POST', '/users/me/change-password'],
      ['GET', '/users/me/mfa'],
      ['POST', '/users/me/mfa/setup'],
      ['POST', '/users/me/mfa/confirm'],
      ['DELETE', '/users/me/mfa'],
      ['GET', '/users/me/notification-preferences'],
      ['PUT', '/users/me/notification-preferences'],
      ['GET', '/users/me/chatbot-ai-config'],
      ['PUT', '/users/me/chatbot-ai-config'],
      ['DELETE', '/users/me/chatbot-ai-config'],
      ['GET', '/users/me/support-ai-config'],
      ['PUT', '/users/me/support-ai-config'],
      ['DELETE', '/users/me/support-ai-config'],
      ['GET', '/users/me/permissions'],
    ] as const
  ).map(([method, path]) => ({ method, path, reason: "the caller's own profile" })),
  {
    method: 'GET',
    path: '/users/me/ai-defaults',
    reason: 'built-in AI prompts and model catalog (code constants, no site data)',
  },
  { method: 'GET', path: '/roles', reason: 'role catalog' },
  { method: 'GET', path: '/permissions', reason: 'permission catalog' },
  {
    method: 'POST',
    path: '/webhooks/payments/*',
    reason: 'payment provider webhooks, signature-verified, no operator',
  },
];
