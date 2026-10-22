// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A later provider adds its id here and its entry to SIM_PROVIDER_ORDER.
export type SimProviderId = 'hologram';

export type SimState =
  | 'active'
  | 'pending'
  | 'suspended'
  | 'inactive'
  | 'deactivated'
  | 'test'
  | 'unknown';

/** What a provider reports. The CSMS shows only the fields a provider supports. */
export interface SimCapabilities {
  networkName: boolean;
  radioAccessTechnology: boolean;
  cellId: boolean;
  usage: boolean;
  sessions: boolean;
  alerts: boolean;
  networkReset: boolean;
}

/** What a match stores: the provider SIM id plus the provider's other ids. */
export interface SimRef {
  /** Hologram: the device id (the ICCID can change with a profile fallback). */
  providerSimId: string;
  /** Hologram: links.cellular[].id, used for sessions and the network reset. */
  linkId?: string;
  /** Hologram: the SIM card id, used for usage. */
  simcardId?: string;
}

export interface SimUsage {
  bytes: number;
  /** ISO 8601 UTC end of the billing period. */
  periodEnd: string | null;
  /** Plan data plus the overage limit, when the provider reports both. */
  limitBytes: number | null;
}

export interface SimStatus {
  providerSimId: string;
  iccid: string;
  imsi: string | null;
  state: SimState;
  /** The provider's own state name, kept beside the mapped state. */
  providerState: string;
  inSession: boolean | null;
  /** ISO 8601 UTC begin of the open data session, if any. */
  openSessionBeganAt: string | null;
  apn: string | null;
  profileName: string | null;
  lastSessionAt: string | null;
  usage: SimUsage | null;
}

/** One closed data session. */
export interface SimSession {
  /** Hologram record_id: unique and increasing. */
  providerSessionId: string;
  startedAt: string;
  endedAt: string;
  bytes: number | null;
  networkName: string | null;
  radioAccessTechnology: string | null;
  cellId: string | null;
  apn: string | null;
}

export type SimAlertKind =
  | 'data_limit'
  | 'data_warning'
  // The SIM moved to another device. No device identifier is kept.
  | 'device_changed'
  | 'device_model_changed'
  | 'first_device';

export interface SimAlert {
  providerAlertId: string;
  kind: SimAlertKind;
  receivedAt: string;
}

export interface SimPage<T> {
  items: T[];
  /** Never true without a `lastId`: a page that cannot be followed ends the paging. */
  continues: boolean;
  /** Pass as `startAfter` to fetch the next page. */
  lastId: string | null;
}

export interface SimTimeRange {
  from: Date;
  to: Date;
}

export interface SimResetResult {
  // Hologram's reset is synchronous; an asynchronous provider adds 'submitted'.
  status: 'accepted';
}

export interface SimProvider {
  readonly id: SimProviderId;
  readonly capabilities: SimCapabilities;
  /** How far back the provider keeps sessions and alerts. */
  readonly historyDays: number;
  /** How late the provider reports a closed session. */
  readonly reportingDelayHours: number;
  findByIccid(iccid: string): Promise<SimRef | null>;
  getStatus(ref: SimRef): Promise<SimStatus>;
  /** Newest first. `startAfter` is a provider record id. */
  listSessions(
    ref: SimRef,
    page: { startAfter?: string; range?: SimTimeRange },
  ): Promise<SimPage<SimSession>>;
  /** Newest first. */
  listAlerts(
    ref: SimRef,
    page: { startAfter?: string; range: SimTimeRange },
  ): Promise<SimPage<SimAlert>>;
  resetNetwork(ref: SimRef): Promise<SimResetResult>;
  testConnection(): Promise<SimConnectionResult>;
}

export interface SimOrganizationCount {
  id: string;
  name: string;
  deviceCount: number;
}

/** What Test Connection found, so Settings can warn about an organization without SIMs. */
export interface SimConnectionResult {
  /** SIMs in the stored organization. */
  deviceCount: number;
  /** Other organizations the key reaches, at most 10, each with its SIM count. */
  otherOrganizations: SimOrganizationCount[];
}

export interface HologramSettings {
  enabled: boolean;
  apiKey: string;
  orgId: string;
}

/** The decrypted provider settings a registry builds adapters from. */
export interface SimProviderSettings {
  hologram: HologramSettings;
}

export type SimProviderErrorKind =
  | 'auth'
  | 'not_found'
  | 'rate_limited'
  | 'unsupported'
  | 'unavailable';

export class SimProviderError extends Error {
  readonly kind: SimProviderErrorKind;
  /** From the provider's Retry-After, for a rate_limited error. */
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: SimProviderErrorKind,
    message: string,
    options?: { cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SimProviderError';
    this.kind = kind;
    this.retryAfterSeconds = options?.retryAfterSeconds ?? null;
  }
}
