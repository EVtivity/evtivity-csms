// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  buildCssConfigDefaults,
  CSS_RETRY_BACK_OFF_DEFAULTS,
  CSS_STATUS_REPORTING_DEFAULT,
  CSS_STATUS_REPORTING_KEY,
  CSS_STATUS_REPORTING_VALUES,
  cssSecurityCtrlrDefaults,
  TOTP_VERSION_V1,
  totpV1,
} from '@evtivity/lib';
import { validateStationPassword } from '@evtivity/lib/station-password';
import { OcppClient } from './ocpp-client.js';
import { config as cssConfig } from './lib/config.js';
import { logger } from './lib/logger.js';
import { MeterValueGenerator } from './meter-value-generator.js';
import { OcmfMeterSigner } from './signed-meter-values.js';
import { computeCompositeSchedule } from './composite-schedule.js';
import { CSS_MANUFACTURER_ROOT_CA_PEM, parseFirmwareImage } from './lib/manufacturer-root.js';
import { PersistedCache } from './lib/persisted-cache.js';
import { endedTriggerFor21, faultStopReason, isStopReasonFor } from './lib/stop-reasons.js';
import {
  checkIso2Response,
  checkIso20Response,
  contractCertificateHashData,
  randomPcid,
  TestEv,
  type Edition,
  type InstalledContract,
} from './lib/iso15118-test-ev.js';
import type { CachePersistor, CacheLogger } from './lib/persisted-cache.js';
import {
  certificateHashData,
  certificateMatchesPrivateKey,
  chainsToTrustedRoot,
  generateKeyPairAndCsr,
  isCertificateHashAlgorithm,
  isCaCertificate,
  isIssuedBy,
  isSelfSigned,
  isWithinValidity,
  parseCertificateChain,
  sameCertificateHashData,
  verifySignature,
} from './lib/station-pki.js';
import type { X509Certificate } from 'node:crypto';

/**
 * A variable monitor (OCPP 2.1 N04 SetVariableMonitoring, VariableMonitoringType)
 * as stored in css_variable_monitors. Rows written before `value`, `transaction`,
 * and `periodicEventStream` existed lack them.
 */
type VariableMonitor = {
  id: number;
  type: string;
  severity: number;
  component: Record<string, unknown>;
  variable: Record<string, unknown>;
  isHardwired: boolean;
  value?: number | undefined;
  transaction?: boolean | undefined;
  periodicEventStream?: { interval?: number; values?: number } | undefined;
  /** Factory (preconfigured) monitor: SetMonitoringBase HardWiredOnly removes it, FactoryDefault restores it. */
  preconfigured?: boolean | undefined;
};

/** EventNotificationEnumType of a monitor's events and reports. */
function monitorNotificationType(monitor: VariableMonitor): string {
  if (monitor.isHardwired) return 'HardWiredMonitor';
  return monitor.preconfigured === true ? 'PreconfiguredMonitor' : 'CustomMonitor';
}

/** Price sections of an OCPP 2.1 TariffType. */
const TARIFF_PRICE_SECTIONS = [
  'energy',
  'chargingTime',
  'idleTime',
  'fixedFee',
  'reservationTime',
  'reservationFixed',
] as const;

/** Display languages (RFC 5646) the simulator can show: DisplayMessageCtrlr.Language valuesList. */
const DISPLAY_LANGUAGES = ['en', 'de', 'nl', 'fr', 'es'];

/**
 * Device model variables that are WriteOnly: GetVariables rejects them (B06.FR.09), reports
 * leave out their value, and monitors report them with an empty value.
 */
const WRITE_ONLY_VARIABLES = new Set([
  'SecurityCtrlr.BasicAuthPassword',
  'WebPaymentsCtrlr.SharedSecret',
]);

/** C25 URL query parameters for limits the EV driver enters (WebPaymentsCtrlr.URLParameters). */
type WebPaymentLimits = { maxEnergy?: number; maxTime?: number; maxCost?: number };
const WEB_PAYMENT_URL_PARAMETERS: ReadonlyArray<[keyof WebPaymentLimits, string]> = [
  ['maxTime', 'maxtime'],
  ['maxEnergy', 'maxenergy'],
  ['maxCost', 'maxcost'],
];

/** A monitoring event with the severity of the monitor that raised it. */
interface MonitorEvent {
  severity: number;
  event: Record<string, unknown>;
}

/** An open OCPP 2.1 periodic event stream (N11) for a Periodic monitor. */
interface PeriodicStream {
  id: number;
  monitorId: number;
  /** Seconds after which buffered data is sent (params.interval). */
  interval: number;
  /** Number of data elements sent together (params.values). */
  values: number;
  basetime: number;
  data: Array<{ t: number; v: string }>;
  sampleTimer: ReturnType<typeof setInterval> | null;
  flushTimer: ReturnType<typeof setInterval> | null;
}

/** A 2.1 SampledValueType as the simulator builds it (value, measurand, unitOfMeasure, context, ...). */
type SampledValueRecord = Record<string, unknown>;

export interface StationConfig {
  id: string;
  stationId: string;
  ocppProtocol: 'ocpp1.6' | 'ocpp2.1';
  securityProfile: number;
  targetUrl: string;
  password?: string;
  vendorName: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
  clientCert?: string;
  clientKey?: string;
  caCert?: string;
  /** Verify the server certificate on wss:// (on unless false, or TLS_REJECT_UNAUTHORIZED=false). */
  verifyServerCertificate?: boolean;
  /** Factory values that replace configuration defaults when the station is first seeded
   *  (for example a 1.6 SupportedFeatureProfiles or LocalAuthListMaxLength). */
  configOverrides?: Record<string, string>;
  /** Random extra delay (ms) before the first reconnect after a connection loss. */
  reconnectSpreadMs?: number;
  evses: Array<{
    evseId: number;
    connectorId: number;
    connectorType: 'ac_type2' | 'ac_type1' | 'dc_ccs2' | 'dc_ccs1' | 'dc_chademo';
    maxPowerW: number;
    phases: number;
    voltage: number;
    /** The cable is fixed to the connector, so it has no lock to release. */
    fixedCable?: boolean;
  }>;
}

// A certificate in the station's certificate store. `certificate` holds the PEM
// for certificates the station parsed itself (OCPP 1.6 Security Whitepaper).
interface InstalledCertificate {
  certificateType: string;
  certificateHashData: Record<string, string>;
  certificate?: string;
}

// Connection settings a station tries after a reboot, in order.
interface ConnectionCandidate {
  serverUrl: string;
  password: string;
  securityProfile: number;
}

// Attempts per network profile before falling back to the next one.
const CONNECTION_ATTEMPTS_PER_PROFILE = 3;

interface Reservation {
  id: number;
  evseId: number;
  idToken: string;
  groupIdToken?: string | undefined;
  connectorType?: string | undefined;
  expiryDateTime: string;
}

interface EvseContext {
  state: string;
  authorizedToken: string | null;
  authorizedTokenType: string | null;
  transactionId: string | null;
  remoteStartId: number | null;
  cablePlugged: boolean;
}

// A real station keeps reporting Unavailable until the operator restores
// Operative. A chaos or manual StatusNotification must never contradict
// administrative unavailability by reporting Available/Occupied/etc. Faulted
// is allowed through because a fault can occur while administratively down.
export function clampStatusForAdminAvailability(status: string, adminUnavailable: boolean): string {
  if (!adminUnavailable) return status;
  if (status === 'Unavailable' || status === 'Faulted') return status;
  return 'Unavailable';
}

export class StationSimulator {
  readonly client: OcppClient;
  private readonly config: StationConfig;
  private readonly sql: postgres.Sql;
  private readonly meterGens = new Map<number, MeterValueGenerator>();
  private readonly meterTimers = new Map<number, ReturnType<typeof setInterval>>();
  private reservations!: PersistedCache<number, Reservation>;
  // Live setTimeout handles paired with each persisted reservation; rebuilt
  // from the cache on boot via scheduleReservationExpiry().
  private readonly reservationTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly evseContexts = new Map<number, EvseContext>();

  // Device-storage-backed config variables. Reads are local; .set/.delete
  // auto-persist to css_config_variables. Boot loader pulls existing rows
  // and falls back to factory defaults when DB is empty.
  private configVariables!: PersistedCache<string, { value: string; readonly: boolean }>;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ConnectionTimeOut timers per EVSE (1.6 authorize-without-cable)
  private readonly connectionTimeoutTimers = new Map<number, ReturnType<typeof setTimeout>>();
  // OCPP 2.1 EVConnectionTimeout timers per EVSE (remote start without cable)
  private readonly evConnectTimeoutTimers = new Map<number, ReturnType<typeof setTimeout>>();

  // Per-EVSE charging state
  private readonly evsePowerLimits = new Map<number, number | null>();
  private readonly evseIdle = new Map<number, boolean>();
  /** Plug and Charge EV per EVSE and its installed contract (in memory, like the EV). */
  private readonly pncEvs = new Map<number, { ev: TestEv; contract: InstalledContract | null }>();
  private readonly evseChargingState = new Map<number, string | null>();
  private readonly evseSeqNo = new Map<number, number>();
  private readonly evseMeterTick = new Map<number, number>();
  private readonly evseConnectorStatus = new Map<number, string>();
  // EVSEs the operator has administratively taken down via ChangeAvailability.
  // Tracked separately from evseConnectorStatus because the connector status
  // churns through Finishing/EVConnected during a stop sequence; this set is
  // the authoritative source for whether the post-transaction resting status
  // must clamp to Unavailable.
  private readonly evseAdminUnavailable = new Set<number>();

  // Clock-aligned meter value timer
  private clockAlignedTimer: ReturnType<typeof setInterval> | null = null;

  // Station-level state
  private availabilityState = 'Operative';
  private bootStatus: 'Accepted' | 'Pending' | 'Rejected' | null = null;
  // One BootNotification retry at a time; a new boot replaces a scheduled retry.
  private bootRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingReset: string | null = null;
  private destroyed = false;
  private rebootCandidates: ConnectionCandidate[] | null = null;
  private activeRebootCandidate: ConnectionCandidate | null = null;
  // OCPP 1.6 SecurityProfile accepted via ChangeConfiguration, applied on reset.
  private pendingSecurityProfile16: number | null = null;
  // OCPP 1.6 Security Whitepaper: private key of the CSR sent in SignCertificate,
  // kept until CertificateSigned delivers the matching certificate.
  private pendingChargePointKey16: string | null = null;
  // OCPP 1.6 Security Whitepaper: requestId of the running SignedUpdateFirmware,
  // so a new request cancels it (AcceptedCanceled).
  private activeSignedFirmwareRequestId: number | null = null;
  // OCPP 2.1 L01: the running UpdateFirmware (requestId, past Installing or not),
  // and the EVSEs set Unavailable while an installation waits for transactions.
  private activeFirmwareUpdate21: { requestId: number; installing: boolean } | null = null;
  private readonly firmwareBlockedEvses = new Set<number>();
  // Connectors whose lock is jammed (simulated hardware fault, jamConnectorLock()).
  private readonly jammedLocks = new Set<number>();
  private offlineFlag = false;
  // A reboot or power cycle dropped the connection: the next connection boots
  // (BootNotification). A plain connection loss does not (1.6 4.2, 2.1 B01/B04).
  private rebootOnReconnect = false;
  // start() finished its boot sequence once. When the first connection failed,
  // the reconnect that eventually succeeds runs it instead.
  private initialBootDone = false;
  // When the current offline period began, and the connector statuses last
  // reported before it, so a reconnect reports what changed (2.1 B04).
  private offlineSince: number | null = null;
  private statusesAtDisconnect: Map<number, string> | null = null;
  // Connector statuses the CSMS acknowledged. A report still in flight when the
  // connection drops was not delivered, so the reconnect reports it (B04).
  private readonly deliveredConnectorStatus = new Map<number, string>();
  // OCPP 1.6: EVSEs whose transaction a power loss interrupted, stopped after the reboot.
  private interruptedTransactions16 = new Set<number>();
  // Key pairs of the CSRs sent per certificateType, awaiting CertificateSigned (A02).
  private readonly pendingCsrKeys = new Map<string, string[]>();
  // A02.FR.17-19 resend timers per certificateType.
  private readonly certSigningTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private certificateReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Readiness for the manager's self-heal watchdog. ready is true once the
  // station has booted Accepted and reported its connector statuses.
  // notReadySince marks how long it has been continuously not-ready, so a brief
  // reconnect is not mistaken for a stuck station.
  private ready = false;
  private notReadySince: number | null = null;
  // Offline message queue: a FIFO log of OCPP calls deferred while the
  // WebSocket is down. Each item is paired with its DB row id so the shift
  // path can delete the persisted row. Loaded on boot from
  // css_offline_messages so a power cycle doesn't drop pending messages.
  // Signed meter values (2.1 J01.FR.21, J02.FR.21): the simulated meter's
  // signing unit, created on first use, and the EVSEs whose transaction has
  // already carried the public key (PublicKeyWithSignedMeterValue OncePerTransaction).
  private meterSigner: OcmfMeterSigner | null = null;
  private readonly evsePublicKeySent = new Set<number>();
  // Meter data collected for the TransactionEvent Ended (2.1 J01/J02:
  // SampledDataCtrlr.TxEndedInterval / AlignedDataCtrlr.TxEndedInterval).
  private readonly evseTxEndedMeterValues = new Map<number, Array<Record<string, unknown>>>();
  private readonly txEndedTimers = new Map<number, Array<ReturnType<typeof setTimeout>>>();

  // O01: preferred language of the EV driver per EVSE (AuthorizeResponse language1).
  private readonly evseDriverLanguage = new Map<number, string>();

  /** True while replayOfflineQueue drains the queue (one drain at a time). */
  private replayingOfflineQueue = false;
  private offlineMessageQueue: Array<{
    id: string;
    action: string;
    payload: Record<string, unknown>;
    /** 1.6 StartTransaction queued offline: the temporary local transaction id it started. */
    localTransactionId?: string;
  }> = [];
  private localAuthListVersion = 0;
  private localAuthEntries!: PersistedCache<string, Record<string, unknown>>;

  // Preserved transactions for power cycle resume (OCPP 2.1)
  private preservedTransactions = new Map<
    number,
    { transactionId: string; idToken: string; tokenType: string; powerLossTime: number }
  >();

  // Authorization cache (OCPP 2.1 AuthCacheCtrlr): token -> idTokenInfo from CSMS.
  // Persisted to css_auth_cache so an offline reboot still answers Authorize
  // for tokens that were recently approved.
  private authCache!: PersistedCache<string, Record<string, unknown>>;

  // Group ID mapping (Feature 3): token value -> groupIdToken object
  private readonly tokenGroupMap = new Map<string, Record<string, unknown>>();

  // Track start token per transaction (Feature 3): txId -> { idToken, groupIdToken }
  private readonly transactionStartTokens = new Map<
    string,
    { idToken: string; groupIdToken: Record<string, unknown> | null }
  >();

  // Master pass group ID (Feature 4): set when authorize returns a groupIdToken
  private masterPassGroupId: string | null = null;

  // Track current log and firmware upload status for TriggerMessage
  private logUploadStatus: string = 'Idle';
  private firmwareUpdateStatus: string = 'Idle';

  // Custom triggers support
  private readonly customTriggers: string[] = ['DiagnosticsLog', 'SecurityAudit'];

  // Variable monitoring state
  private monitorIdCounter = 0;
  private variableMonitors!: PersistedCache<number, VariableMonitor>;
  // Monitor evaluation state (volatile): last value a Delta monitor reported
  // from, and whether a threshold monitor is currently exceeded.
  private readonly monitorDeltaBase = new Map<number, number | string>();
  private readonly monitorExceeded = new Set<number>();
  private eventIdCounter = 0;
  // N11-N15 periodic monitoring: NotifyEvent timers for Periodic monitors
  // without a stream, and open periodic event streams keyed by monitor id.
  private readonly periodicMonitorTimers = new Map<number, ReturnType<typeof setInterval>>();
  private readonly periodicStreams = new Map<number, PeriodicStream>();
  private streamIdCounter = 0;
  private monitoringLevel = 9; // default: report all severities (0-9)

  // Active log upload tracking
  private activeLogUploadRequestId: number | null = null;

  // Customer data store, backed by css_customer_data so CustomerInformation
  // updates survive a power cycle.
  private customerDataStore!: PersistedCache<string, string>;

  // Device-storage-backed CSMS-command caches. Reads are local; .set/.delete
  // auto-persist to their css_* tables. Boot loaders run in start().
  private displayMessagesCache!: PersistedCache<number, Record<string, unknown>>;
  private installedCertificatesCache!: PersistedCache<string, InstalledCertificate>;
  private chargingProfilesCache!: PersistedCache<number, Record<string, unknown>>;

  // Tariff store: tariffId -> { evseId, tariff data, inUse }
  private readonly defaultTariffs = new Map<
    string,
    { evseId: number; tariff: Record<string, unknown>; inUse: boolean }
  >();
  // Track transaction currency: transactionId -> currency
  private readonly transactionTariffCurrency = new Map<string, string>();
  // Per-EVSE driver tariff received from AuthorizeResponse (OCPP 2.1)
  private readonly driverTariffs = new Map<
    number,
    { tariffId: string; tariff: Record<string, unknown> }
  >();

  // Per-EVSE transaction limit state (OCPP 2.1)
  private readonly evseTransactionLimits = new Map<
    number,
    { maxEnergy?: number; maxTime?: number; maxCost?: number }
  >();
  // Per-EVSE CSMS-provided running totalCost
  private readonly evseTotalCost = new Map<number, number>();
  // Per-EVSE transaction start time (for time limit tracking)
  private readonly evseTransactionStartTime = new Map<number, number>();
  // Per-EVSE flag to prevent duplicate limit-reached events
  private readonly evseLimitReached = new Map<number, boolean>();
  // Per-EVSE snapshot of last-reported driver-set limits (for change detection)
  private readonly evseLastDriverLimits = new Map<
    number,
    { maxEnergy?: number; maxTime?: number; maxCost?: number } | null
  >();
  // C25.FR.03: limits the EV driver entered for a QR code payment, per EVSE. Added to the
  // QR code URL and to the transaction started on the EVSE (C25.FR.04-06).
  private readonly evseWebPaymentLimits = new Map<number, WebPaymentLimits>();
  // E05.FR.03: energy (Wh, transaction total) still allowed after CSMS rejected the idToken
  private readonly evseInvalidIdMaxEnergy = new Map<number, number>();
  // Per-EVSE last reported local cost (for RunningCost event dedup)
  private readonly evseLastLocalCost = new Map<number, number>();

  constructor(config: StationConfig, sql: postgres.Sql) {
    this.config = config;
    this.sql = sql;

    const cacheLogger: CacheLogger = {
      warn: (msg, ctx) => {
        console.warn(`[${this.config.stationId}] ${msg}`, ctx ?? '');
      },
    };

    const configPersistor: CachePersistor<string, { value: string; readonly: boolean }> = {
      load: async () => {
        const rows = await this.sql<Array<{ key: string; value: string; readonly: boolean }>>`
          SELECT key, value, readonly FROM css_config_variables
          WHERE css_station_id = ${this.config.id}
        `;
        return rows.map(
          (r) =>
            [r.key, { value: r.value, readonly: r.readonly }] as readonly [
              string,
              { value: string; readonly: boolean },
            ],
        );
      },
      upsert: async (key, v) => {
        const id = 'ccv_' + randomUUID().replace(/-/g, '').slice(0, 12);
        await this.sql`
          INSERT INTO css_config_variables (id, css_station_id, key, value, readonly)
          VALUES (${id}, ${this.config.id}, ${key}, ${v.value}, ${v.readonly})
          ON CONFLICT (css_station_id, key) DO UPDATE
          SET value = EXCLUDED.value, readonly = EXCLUDED.readonly
        `;
      },
      remove: async (key) => {
        await this.sql`
          DELETE FROM css_config_variables
          WHERE css_station_id = ${this.config.id} AND key = ${key}
        `;
      },
    };
    this.configVariables = new PersistedCache(configPersistor, cacheLogger, 'configVariables');

    const certPersistor: CachePersistor<string, InstalledCertificate> = {
      load: async () => {
        const rows = await this.sql<
          Array<{
            certificate_type: string;
            hash_algorithm: string;
            issuer_name_hash: string | null;
            issuer_key_hash: string | null;
            serial_number: string;
            certificate: string | null;
          }>
        >`
          SELECT certificate_type, hash_algorithm, issuer_name_hash, issuer_key_hash, serial_number,
                 certificate
          FROM css_installed_certificates
          WHERE css_station_id = ${this.config.id}
        `;
        return rows.map(
          (r) =>
            [
              r.serial_number,
              {
                certificateType: r.certificate_type,
                certificateHashData: {
                  hashAlgorithm: r.hash_algorithm,
                  issuerNameHash: r.issuer_name_hash ?? '',
                  issuerKeyHash: r.issuer_key_hash ?? '',
                  serialNumber: r.serial_number,
                },
                ...(r.certificate != null ? { certificate: r.certificate } : {}),
              },
            ] as readonly [string, InstalledCertificate],
        );
      },
      upsert: async (serial, v) => {
        const id = 'ccr_' + randomUUID().replace(/-/g, '').slice(0, 12);
        await this.sql`
          INSERT INTO css_installed_certificates
            (id, css_station_id, certificate_type, serial_number, hash_algorithm, issuer_name_hash,
             issuer_key_hash, certificate)
          VALUES (
            ${id}, ${this.config.id}, ${v.certificateType}, ${serial},
            ${v.certificateHashData['hashAlgorithm'] ?? 'SHA256'},
            ${v.certificateHashData['issuerNameHash'] ?? ''},
            ${v.certificateHashData['issuerKeyHash'] ?? ''},
            ${v.certificate ?? null}
          )
          ON CONFLICT (css_station_id, serial_number) DO UPDATE
          SET certificate_type = EXCLUDED.certificate_type,
              hash_algorithm = EXCLUDED.hash_algorithm,
              issuer_name_hash = EXCLUDED.issuer_name_hash,
              issuer_key_hash = EXCLUDED.issuer_key_hash,
              certificate = EXCLUDED.certificate
        `;
      },
      remove: async (serial) => {
        await this.sql`
          DELETE FROM css_installed_certificates
          WHERE css_station_id = ${this.config.id} AND serial_number = ${serial}
        `;
      },
      clear: async () => {
        await this.sql`
          DELETE FROM css_installed_certificates WHERE css_station_id = ${this.config.id}
        `;
      },
    };
    this.installedCertificatesCache = new PersistedCache(
      certPersistor,
      cacheLogger,
      'installedCertificatesCache',
    );

    const chargingProfilePersistor: CachePersistor<number, Record<string, unknown>> = {
      load: async () => {
        const rows = await this.sql<
          Array<{
            profile_id: number;
            evse_id: number | null;
            profile_data: Record<string, unknown>;
          }>
        >`
          SELECT profile_id, evse_id, profile_data
          FROM css_charging_profiles
          WHERE css_station_id = ${this.config.id}
        `;
        return rows.map(
          (r) =>
            [r.profile_id, { ...r.profile_data, _evseId: r.evse_id }] as readonly [
              number,
              Record<string, unknown>,
            ],
        );
      },
      upsert: async (profileId, v) => {
        const id = 'ccp_' + randomUUID().replace(/-/g, '').slice(0, 12);
        const evseId = v['_evseId'] as number | undefined;
        const data = { ...v };
        delete (data as Record<string, unknown>)['_evseId'];
        await this.sql`
          INSERT INTO css_charging_profiles (id, css_station_id, profile_id, evse_id, profile_data)
          VALUES (${id}, ${this.config.id}, ${profileId}, ${evseId ?? null}, ${this.sql.json(data as Parameters<postgres.Sql['json']>[0])})
          ON CONFLICT (css_station_id, profile_id) DO UPDATE
          SET evse_id = EXCLUDED.evse_id, profile_data = EXCLUDED.profile_data
        `;
      },
      remove: async (profileId) => {
        await this.sql`
          DELETE FROM css_charging_profiles
          WHERE css_station_id = ${this.config.id} AND profile_id = ${profileId}
        `;
      },
      clear: async () => {
        await this.sql`
          DELETE FROM css_charging_profiles WHERE css_station_id = ${this.config.id}
        `;
      },
    };
    this.chargingProfilesCache = new PersistedCache(
      chargingProfilePersistor,
      cacheLogger,
      'chargingProfilesCache',
    );

    const displayMessagePersistor: CachePersistor<number, Record<string, unknown>> = {
      load: async () => {
        const rows = await this.sql<
          Array<{ message_id: number; message_data: Record<string, unknown> }>
        >`
          SELECT message_id, message_data
          FROM css_display_messages
          WHERE css_station_id = ${this.config.id}
        `;
        return rows.map(
          (r) => [r.message_id, r.message_data] as readonly [number, Record<string, unknown>],
        );
      },
      upsert: async (msgId, v) => {
        const id = 'cdm_' + randomUUID().replace(/-/g, '').slice(0, 12);
        await this.sql`
          INSERT INTO css_display_messages (id, css_station_id, message_id, message_data)
          VALUES (${id}, ${this.config.id}, ${msgId}, ${this.sql.json(v as Parameters<postgres.Sql['json']>[0])})
          ON CONFLICT (css_station_id, message_id) DO UPDATE
          SET message_data = EXCLUDED.message_data
        `;
      },
      remove: async (msgId) => {
        await this.sql`
          DELETE FROM css_display_messages
          WHERE css_station_id = ${this.config.id} AND message_id = ${msgId}
        `;
      },
      clear: async () => {
        await this.sql`
          DELETE FROM css_display_messages WHERE css_station_id = ${this.config.id}
        `;
      },
    };
    this.displayMessagesCache = new PersistedCache(
      displayMessagePersistor,
      cacheLogger,
      'displayMessagesCache',
    );

    const localAuthPersistor: CachePersistor<string, Record<string, unknown>> = {
      load: async () => {
        const rows = await this.sql<
          Array<{
            id_token: string;
            token_type: string | null;
            auth_status: string;
            list_version: number;
            entry_data: Record<string, unknown> | null;
          }>
        >`
          SELECT id_token, token_type, auth_status, list_version, entry_data
          FROM css_local_auth_entries
          WHERE css_station_id = ${this.config.id}
        `;
        let maxVer = 0;
        const out: Array<readonly [string, Record<string, unknown>]> = [];
        for (const r of rows) {
          if (r.list_version > maxVer) maxVer = r.list_version;
          const entry: Record<string, unknown> = r.entry_data ?? { authStatus: r.auth_status };
          if (entry['authStatus'] == null) entry['authStatus'] = r.auth_status;
          if (entry['tokenType'] == null && r.token_type != null) entry['tokenType'] = r.token_type;
          out.push([r.id_token, entry]);
        }
        if (this.localAuthListVersion < maxVer) this.localAuthListVersion = maxVer;
        return out;
      },
      upsert: async (idToken, v) => {
        const id = 'cla_' + randomUUID().replace(/-/g, '').slice(0, 12);
        const status = (v['authStatus'] as string | undefined) ?? 'Accepted';
        const tokenType = (v['tokenType'] as string | undefined) ?? 'ISO14443';
        await this.sql`
          INSERT INTO css_local_auth_entries
            (id, css_station_id, id_token, token_type, auth_status, list_version, entry_data)
          VALUES (
            ${id}, ${this.config.id}, ${idToken}, ${tokenType}, ${status},
            ${this.localAuthListVersion},
            ${this.sql.json(v as Parameters<postgres.Sql['json']>[0])}
          )
          ON CONFLICT (css_station_id, id_token) DO UPDATE
          SET token_type = EXCLUDED.token_type,
              auth_status = EXCLUDED.auth_status,
              list_version = EXCLUDED.list_version,
              entry_data = EXCLUDED.entry_data
        `;
      },
      remove: async (idToken) => {
        await this.sql`
          DELETE FROM css_local_auth_entries
          WHERE css_station_id = ${this.config.id} AND id_token = ${idToken}
        `;
      },
      clear: async () => {
        await this.sql`
          DELETE FROM css_local_auth_entries WHERE css_station_id = ${this.config.id}
        `;
      },
    };
    this.localAuthEntries = new PersistedCache(localAuthPersistor, cacheLogger, 'localAuthEntries');

    type MonitorValue = VariableMonitor;
    const monitorsPersistor: CachePersistor<number, MonitorValue> = {
      load: async () => {
        const rows = await this.sql<Array<{ monitor_id: number; monitor_data: MonitorValue }>>`
          SELECT monitor_id, monitor_data
          FROM css_variable_monitors
          WHERE css_station_id = ${this.config.id}
        `;
        return rows.map((r) => [r.monitor_id, r.monitor_data] as readonly [number, MonitorValue]);
      },
      upsert: async (monId, v) => {
        const id = 'cvm_' + randomUUID().replace(/-/g, '').slice(0, 12);
        await this.sql`
          INSERT INTO css_variable_monitors (id, css_station_id, monitor_id, monitor_data)
          VALUES (${id}, ${this.config.id}, ${monId}, ${this.sql.json(v as Parameters<postgres.Sql['json']>[0])})
          ON CONFLICT (css_station_id, monitor_id) DO UPDATE
          SET monitor_data = EXCLUDED.monitor_data
        `;
      },
      remove: async (monId) => {
        await this.sql`
          DELETE FROM css_variable_monitors
          WHERE css_station_id = ${this.config.id} AND monitor_id = ${monId}
        `;
      },
      clear: async () => {
        await this.sql`
          DELETE FROM css_variable_monitors WHERE css_station_id = ${this.config.id}
        `;
      },
    };
    this.variableMonitors = new PersistedCache(monitorsPersistor, cacheLogger, 'variableMonitors');

    const customerDataPersistor: CachePersistor<string, string> = {
      load: async () => {
        const rows = await this.sql<Array<{ key: string; value: string }>>`
          SELECT key, value FROM css_customer_data WHERE css_station_id = ${this.config.id}
        `;
        return rows.map((r) => [r.key, r.value] as readonly [string, string]);
      },
      upsert: async (key, value) => {
        const id = 'ccd_' + randomUUID().replace(/-/g, '').slice(0, 12);
        await this.sql`
          INSERT INTO css_customer_data (id, css_station_id, key, value)
          VALUES (${id}, ${this.config.id}, ${key}, ${value})
          ON CONFLICT (css_station_id, key) DO UPDATE SET value = EXCLUDED.value
        `;
      },
      remove: async (key) => {
        await this.sql`
          DELETE FROM css_customer_data
          WHERE css_station_id = ${this.config.id} AND key = ${key}
        `;
      },
      clear: async () => {
        await this.sql`
          DELETE FROM css_customer_data WHERE css_station_id = ${this.config.id}
        `;
      },
    };
    this.customerDataStore = new PersistedCache(
      customerDataPersistor,
      cacheLogger,
      'customerDataStore',
    );

    const authCachePersistor: CachePersistor<string, Record<string, unknown>> = {
      load: async () => {
        const lifeTimeSec = Number(
          this.configVariables.get('AuthCacheCtrlr.LifeTime')?.value ?? '86400',
        );
        const rows = await this.sql<
          Array<{ id_token: string; id_token_info: Record<string, unknown>; cached_at: Date }>
        >`
          SELECT id_token, id_token_info, cached_at
          FROM css_auth_cache
          WHERE css_station_id = ${this.config.id}
        `;
        const cutoff = Date.now() - lifeTimeSec * 1000;
        const out: Array<readonly [string, Record<string, unknown>]> = [];
        for (const r of rows) {
          if (r.cached_at.getTime() < cutoff) continue;
          out.push([r.id_token, r.id_token_info]);
        }
        return out;
      },
      upsert: async (idToken, info) => {
        const id = 'cac_' + randomUUID().replace(/-/g, '').slice(0, 12);
        await this.sql`
          INSERT INTO css_auth_cache (id, css_station_id, id_token, id_token_info, cached_at)
          VALUES (${id}, ${this.config.id}, ${idToken}, ${this.sql.json(info as Parameters<postgres.Sql['json']>[0])}, NOW())
          ON CONFLICT (css_station_id, id_token) DO UPDATE
          SET id_token_info = EXCLUDED.id_token_info, cached_at = EXCLUDED.cached_at
        `;
      },
      remove: async (idToken) => {
        await this.sql`
          DELETE FROM css_auth_cache
          WHERE css_station_id = ${this.config.id} AND id_token = ${idToken}
        `;
      },
      clear: async () => {
        await this.sql`DELETE FROM css_auth_cache WHERE css_station_id = ${this.config.id}`;
      },
    };
    this.authCache = new PersistedCache(authCachePersistor, cacheLogger, 'authCache');

    const reservationPersistor: CachePersistor<number, Reservation> = {
      load: async () => {
        const rows = await this.sql<
          Array<{
            reservation_id: number;
            evse_id: number;
            id_token: string;
            expiry_date_time: Date;
          }>
        >`
          SELECT reservation_id, evse_id, id_token, expiry_date_time
          FROM css_reservations
          WHERE css_station_id = ${this.config.id}
        `;
        return rows.map(
          (r) =>
            [
              r.reservation_id,
              {
                id: r.reservation_id,
                evseId: r.evse_id,
                idToken: r.id_token,
                expiryDateTime: r.expiry_date_time.toISOString(),
              },
            ] as readonly [number, Reservation],
        );
      },
      upsert: async (resId, v) => {
        const id = 'crv_' + randomUUID().replace(/-/g, '').slice(0, 12);
        await this.sql`
          INSERT INTO css_reservations
            (id, css_station_id, reservation_id, evse_id, id_token, expiry_date_time)
          VALUES (${id}, ${this.config.id}, ${resId}, ${v.evseId}, ${v.idToken}, ${v.expiryDateTime})
          ON CONFLICT (css_station_id, reservation_id) DO UPDATE
          SET evse_id = EXCLUDED.evse_id,
              id_token = EXCLUDED.id_token,
              expiry_date_time = EXCLUDED.expiry_date_time
        `;
      },
      remove: async (resId) => {
        await this.sql`
          DELETE FROM css_reservations
          WHERE css_station_id = ${this.config.id} AND reservation_id = ${resId}
        `;
      },
      clear: async () => {
        await this.sql`DELETE FROM css_reservations WHERE css_station_id = ${this.config.id}`;
      },
    };
    this.reservations = new PersistedCache(reservationPersistor, cacheLogger, 'reservations');

    this.client = new OcppClient({
      serverUrl: config.targetUrl,
      stationId: config.stationId,
      ocppProtocol: config.ocppProtocol,
      password: config.password,
      securityProfile: config.securityProfile,
      clientCert: config.clientCert,
      clientKey: config.clientKey,
      caCert: config.caCert,
      verifyServerCertificate: config.verifyServerCertificate,
      reconnectSpreadMs: config.reconnectSpreadMs,
    });

    this.client.setIncomingCallHandler((messageId, action, payload) =>
      this.handleCsmsCommand(messageId, action, payload),
    );

    // Wrap sendCall to track boot status from any BootNotification response,
    // whether sent via sendBootNotification() or raw client.sendCall().
    const originalSendCall = this.client.sendCall.bind(this.client);
    this.client.sendCall = async (action: string, payload: Record<string, unknown>) => {
      const response = await originalSendCall(action, payload);
      if (action === 'BootNotification' && response['status'] != null) {
        this.bootStatus = response['status'] as 'Accepted' | 'Pending' | 'Rejected';
      }
      return response;
    };

    this.client.setConnectedHandler(() => {
      void this.onReconnect();
    });

    // OCPP 2.1 Part 4 5.4: reconnect back-off from OCPPCommCtrlr.RetryBackOff*.
    if (config.ocppProtocol === 'ocpp2.1') {
      this.client.setReconnectBackOff(() => {
        const seconds = (key: string, fallback: number): number => {
          const n = Number(this.getConfigValue(`OCPPCommCtrlr.${key}`) ?? fallback);
          return Number.isFinite(n) && n >= 0 ? n : fallback;
        };
        return {
          waitMinimumMs:
            seconds('RetryBackOffWaitMinimum', CSS_RETRY_BACK_OFF_DEFAULTS.waitMinimumS) * 1000,
          randomRangeMs:
            seconds('RetryBackOffRandomRange', CSS_RETRY_BACK_OFF_DEFAULTS.randomRangeS) * 1000,
          repeatTimes: seconds('RetryBackOffRepeatTimes', CSS_RETRY_BACK_OFF_DEFAULTS.repeatTimes),
        };
      });
    }

    this.client.setBeforeReconnectAttempt((attempt) => {
      this.chooseRebootConnection(attempt);
    });

    this.client.setDisconnectedHandler(() => {
      if (this.offlineSince == null) {
        this.offlineSince = Date.now();
        this.statusesAtDisconnect = new Map(this.deliveredConnectorStatus);
      }
      void this.updateStationStatus('disconnected');
    });

    // A rejected CSMS certificate (OCPP 1.6 Security Whitepaper, 2.1 A00.FR.311)
    // or TLS version (2.1 A00.FR.417) is a critical security event, queued and
    // sent once the station is connected again.
    this.client.setServerCertificateRejectedHandler((err) => {
      this.queueOfflineMessage('SecurityEventNotification', {
        type: this.is16 ? 'InvalidCentralSystemCertificate' : 'InvalidCsmsCertificate',
        timestamp: new Date().toISOString(),
        techInfo: err.message.slice(0, 255),
      });
    });
    this.client.setTlsVersionRejectedHandler((err) => {
      if (this.is16) return;
      this.queueOfflineMessage('SecurityEventNotification', {
        type: 'InvalidTLSVersion',
        timestamp: new Date().toISOString(),
        techInfo: err.message.slice(0, 255),
      });
    });

    // Create MeterValueGenerator per EVSE
    for (const evse of config.evses) {
      this.meterGens.set(
        evse.evseId,
        new MeterValueGenerator({
          connectorType: evse.connectorType,
          maxPowerW: evse.maxPowerW,
          phases: evse.phases,
          voltage: evse.voltage,
        }),
      );
      this.evsePowerLimits.set(evse.evseId, null);
      this.evseIdle.set(evse.evseId, false);
      this.evseChargingState.set(evse.evseId, null);
      this.evseSeqNo.set(evse.evseId, 0);
      this.evseMeterTick.set(evse.evseId, 0);
      this.evseTransactionLimits.delete(evse.evseId);
      this.evseTotalCost.delete(evse.evseId);
      this.evseTransactionStartTime.delete(evse.evseId);
      this.evseLimitReached.delete(evse.evseId);
      this.evseLastDriverLimits.delete(evse.evseId);
      this.evseInvalidIdMaxEnergy.delete(evse.evseId);
      this.evseWebPaymentLimits.delete(evse.evseId);
      this.evseLastLocalCost.delete(evse.evseId);
      this.evseContexts.set(evse.evseId, {
        state: 'Available',
        authorizedToken: null,
        authorizedTokenType: null,
        transactionId: null,
        remoteStartId: null,
        cablePlugged: false,
      });
    }
  }

  get is16(): boolean {
    return this.config.ocppProtocol === 'ocpp1.6';
  }

  get stationId(): string {
    return this.config.stationId;
  }

  get cssStationId(): string {
    return this.config.id;
  }

  get isConnected(): boolean {
    return this.client.isConnected;
  }

  /** True once the station has booted Accepted and reported connector status. */
  isReady(): boolean {
    return this.ready;
  }

  /** Latest BootNotification response status, or null before the first boot. */
  getBootStatus(): 'Accepted' | 'Pending' | 'Rejected' | null {
    return this.bootStatus;
  }

  /** Milliseconds the station has been continuously not-ready (0 when ready). */
  getNotReadyMs(): number {
    return this.notReadySince == null ? 0 : Date.now() - this.notReadySince;
  }

  /** True when chaos goOffline has deliberately parked the station offline. */
  isOffline(): boolean {
    return this.offlineFlag;
  }

  private setReady(value: boolean): void {
    if (value) {
      this.ready = true;
      this.notReadySince = null;
    } else {
      this.ready = false;
      if (this.notReadySince == null) this.notReadySince = Date.now();
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.destroyed = false;
    this.offlineFlag = false;

    await this.loadConfigVariables();
    // A failed first connection throws here. The client keeps retrying, and the
    // connection that succeeds runs the boot sequence (onReconnect).
    await this.client.connect();
    await this.bootAfterPowerUp();
  }

  // The boot sequence after power-up: BootNotification, then (when Accepted)
  // connector statuses and the StartupOfTheDevice security event.
  private async bootAfterPowerUp(): Promise<void> {
    this.initialBootDone = true;
    this.offlineSince = null;
    this.statusesAtDisconnect = null;
    await this.updateStationStatus('booting');
    await this.sendBootNotification('PowerUp');

    // Only send StatusNotification and transition to Available if boot was Accepted.
    // For Pending/Rejected, the retry timer will handle re-boot and status after Accepted.
    if (this.bootStatus !== 'Accepted') return;

    await this.sendChargePointStatus16();
    for (const evse of this.config.evses) {
      const ctx = this.evseContexts.get(evse.evseId) as EvseContext;
      ctx.state = 'Available';
      ctx.cablePlugged = false;
      ctx.authorizedToken = null;
      ctx.authorizedTokenType = null;
      ctx.transactionId = null;
      ctx.remoteStartId = null;
      this.evseConnectorStatus.set(evse.evseId, 'Available');
      await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Available');
      await this.updateEvseStatus(evse.evseId, 'Available');
    }

    await this.updateStationStatus('available');

    // OCPP 2.1 security event: the Charging Station has booted.
    await this.sendStartupSecurityEvent();

    // Seed default hardwired monitors (AvailabilityState Delta for ChargingStation and EVSEs)
    if (!this.is16 && this.variableMonitors.size === 0) {
      this.seedDefaultMonitors();
    }

    // Seed customer data store
    if (this.customerDataStore.size === 0) {
      this.customerDataStore.set('TEST_TOKEN', 'Customer: Test User, Email: test@example.com');
      this.customerDataStore.set('CUST-001', 'Customer: CUST-001, Account: Active');
    }

    // Deliver messages queued before this boot (persisted in css_offline_messages)
    await this.replayOfflineQueue();

    // Start clock-aligned meter value timer
    this.startClockAlignedTimer();
  }

  async stop(): Promise<void> {
    this.destroyed = true;

    // Stop all meter timers
    for (const [evseId] of this.meterTimers) {
      this.stopMeterLoop(evseId);
    }
    for (const evseId of Array.from(this.txEndedTimers.keys())) {
      this.stopTxEndedSampling(evseId);
    }
    for (const monitorId of Array.from(this.periodicMonitorTimers.keys())) {
      this.stopPeriodicNotifyEvents(monitorId);
    }
    for (const stream of this.periodicStreams.values()) {
      this.stopStreamTimers(stream);
    }
    this.periodicStreams.clear();

    this.stopHeartbeat();
    this.stopClockAlignedTimer();
    this.clearBootRetry();

    for (const certificateType of [...this.certSigningTimers.keys()]) {
      this.clearCertSigningTimer(certificateType);
    }
    if (this.certificateReconnectTimer != null) {
      clearTimeout(this.certificateReconnectTimer);
      this.certificateReconnectTimer = null;
    }

    // Clear connection timeout timers
    for (const evseId of this.connectionTimeoutTimers.keys()) {
      this.cancelConnectionTimeoutTimer(evseId);
    }
    for (const evseId of this.evConnectTimeoutTimers.keys()) {
      this.cancelEvConnectTimeoutTimer(evseId);
    }

    // Clear reservation timers (cache.clear() handles the DB-side DELETE)
    for (const id of Array.from(this.reservationTimers.keys())) {
      this.clearReservationTimer(id);
    }
    this.reservations.clear();

    this.client.disconnect();
    await this.updateStationStatus('disconnected');
  }

  // ---------------------------------------------------------------------------
  // Group 1: Driver simulation actions
  // ---------------------------------------------------------------------------

  async plugIn(evseId: number): Promise<void> {
    const ctx = this.evseContexts.get(evseId) as EvseContext;

    // No-op if cable is already plugged AND a transaction is active. Without
    // this guard, clicking Plug In during Charging regresses the connector
    // status to Preparing on the wire, which the portal then renders as a
    // status flash before the next genuine transition.
    if (ctx.cablePlugged && ctx.transactionId != null) {
      return;
    }

    const wasCablePlugged = ctx.cablePlugged;
    ctx.cablePlugged = true;
    this.cancelConnectionTimeoutTimer(evseId);
    this.cancelEvConnectTimeoutTimer(evseId);
    const connectorId = this.getConnectorId(evseId);
    const status = this.is16 ? 'Preparing' : 'Occupied';
    const currentStatus = this.evseConnectorStatus.get(evseId);
    this.evseConnectorStatus.set(evseId, status);
    // Send StatusNotification when the status actually changes, OR for the
    // post-stop "re-plug" refresh -- the cable was already plugged before
    // the user clicked Plug In and there is no active transaction. That
    // refresh clears the CSMS-side `chargingState=EVConnected` overlay
    // from the prior TransactionEvent Ended. The 1.6 authorize-then-plugIn
    // path (cable was NOT yet plugged) skips the duplicate so Preparing is
    // announced exactly once.
    const isPostStopRePlug = wasCablePlugged && ctx.transactionId == null;
    if (currentStatus !== status || isPostStopRePlug) {
      try {
        await this.sendStatusNotification(evseId, connectorId, status);
      } catch (err) {
        logger.debug(
          { err, stationId: this.config.stationId, evseId, connectorId, status },
          'StatusNotification not delivered, the status is reported on reconnect',
        );
      }
    }
    await this.updateEvseStatus(evseId, status);

    // OCPP 2.1: If transaction is suspended (cable was unplugged with
    // StopTxOnEVSideDisconnect=false), resume charging on re-plug.
    if (!this.is16 && ctx.state === 'SuspendedEV' && ctx.transactionId != null) {
      const seqNo1 = (this.evseSeqNo.get(evseId) ?? 0) + 1;
      this.evseSeqNo.set(evseId, seqNo1);
      this.evseChargingState.set(evseId, 'EVConnected');
      await this.sendTransactionEvent(evseId, 'Updated', {
        triggerReason: 'CablePluggedIn',
        transactionId: ctx.transactionId,
        chargingState: 'EVConnected',
        seqNo: seqNo1,
      });
      // Resume charging
      const seqNo2 = seqNo1 + 1;
      this.evseSeqNo.set(evseId, seqNo2);
      this.evseChargingState.set(evseId, 'Charging');
      ctx.state = 'Charging';
      await this.sendTransactionEvent(evseId, 'Updated', {
        triggerReason: 'ChargingStateChanged',
        transactionId: ctx.transactionId,
        chargingState: 'Charging',
        seqNo: seqNo2,
      });
      this.startMeterLoop(evseId);
    } else if (ctx.state === 'Authorized' && ctx.authorizedToken != null) {
      // Auto-start transaction when cable is plugged in after authorization.
      // Same flow for 1.6 and 2.1: clicking Start Charging or RemoteStart
      // before Plug In sets up the authorization (state='Authorized'); the
      // actual transaction begins on Plug In via beginTransaction. Cable is
      // already marked plugged above, so beginTransaction proceeds directly.
      try {
        await this.beginTransaction(
          evseId,
          ctx.authorizedToken,
          ctx.authorizedTokenType ?? 'ISO14443',
          ctx.remoteStartId ?? undefined,
        );
      } catch (err) {
        logger.warn(
          { err, stationId: this.config.stationId, evseId },
          'Auto-start of the transaction failed',
        );
      }
    } else {
      ctx.state = 'Preparing';
    }
  }

  async authorize(
    evseId: number,
    idToken: string,
    tokenType: string = 'ISO14443',
  ): Promise<Record<string, unknown>> {
    // OCPP 2.1: DisableRemoteAuthorization means only check local list/cache
    if (!this.is16 && this.getConfigValue('AuthCtrlr.DisableRemoteAuthorization') === 'true') {
      const localEntry = this.localAuthEntries.get(idToken);
      if (localEntry != null) {
        const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
        const statusField = 'idTokenInfo';
        return { [statusField]: { status } };
      }
      const cached = this.cachedIdTokenInfo(idToken);
      if (cached != null) {
        return { idTokenInfo: cached };
      }
      // Token not found locally: reject without contacting CSMS
      return { idTokenInfo: { status: 'Unknown' } };
    }

    const result = await this.sendAuthorize(idToken, tokenType);
    const ctx = this.evseContexts.get(evseId) as EvseContext;

    // Feature 3+4: GroupId and MasterPass stop (2.1 only)
    if (!this.is16) {
      const info = result['idTokenInfo'] as Record<string, unknown> | undefined;
      // Get groupId from CSMS response or from pre-stored tokenGroupMap (local auth / cache)
      let groupId: string | undefined;
      if (info != null && info['status'] === 'Accepted' && info['groupIdToken'] != null) {
        const groupToken = info['groupIdToken'] as Record<string, unknown>;
        groupId = groupToken['idToken'] as string | undefined;
      } else if (info != null && info['status'] === 'Accepted') {
        const storedGroup = this.tokenGroupMap.get(idToken);
        if (storedGroup != null) {
          groupId = storedGroup['idToken'] as string | undefined;
        }
      }
      if (groupId != null) {
        // Check if this is a MasterPass groupId
        const masterPassGroupId = this.getConfigValue('AuthCtrlr.MasterPassGroupId');
        const isMasterPass = masterPassGroupId != null && masterPassGroupId === groupId;

        if (isMasterPass) {
          // MasterPass: stop ALL active transactions
          console.log(
            `[${this.config.stationId}] MasterPass groupId match - stopping all active transactions`,
          );
          for (const evse of this.config.evses) {
            const tx = await this.getActiveTransaction(evse.evseId);
            if (tx != null) {
              await this.stopCharging(evse.evseId, 'MasterPass');
            }
          }
          return result;
        }

        // Regular GroupId: stop the transaction on this EVSE if groupId matches
        const ctx = this.evseContexts.get(evseId) as EvseContext;
        if (ctx.transactionId != null) {
          const startInfo = this.transactionStartTokens.get(ctx.transactionId);
          if (startInfo != null && startInfo.groupIdToken != null) {
            const startGroupId = startInfo.groupIdToken['idToken'] as string | undefined;
            if (startGroupId === groupId && startInfo.idToken !== idToken) {
              console.log(
                `[${this.config.stationId}] GroupId match - stopping transaction on EVSE ${String(evseId)}`,
              );
              await this.stopCharging(evseId, 'Local');
              return result;
            }
          }
        }
      }
    }

    // Check auth result
    const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
    const authInfo = result[statusField] as Record<string, unknown> | undefined;
    if (authInfo?.['status'] !== 'Accepted') return result;

    // O01: messages are shown in the EV driver's preferred language
    const language1 = authInfo['language1'] as string | undefined;
    if (!this.is16 && language1 != null) this.evseDriverLanguage.set(evseId, language1);

    // Store auth in context
    ctx.authorizedToken = idToken;
    ctx.authorizedTokenType = tokenType;

    // OCPP 2.1: Consume matching reservation on authorize (1.6 consumes in beginTransaction)
    if (!this.is16)
      for (const [resId, res] of this.reservations) {
        if (res.evseId === evseId || res.evseId === 0) {
          // Match by idToken or groupIdToken
          const tokenMatches = res.idToken === idToken;
          const groupMatches = res.groupIdToken != null && res.groupIdToken === idToken;
          if (tokenMatches || groupMatches) {
            this.clearReservationTimer(resId);
            this.reservations.delete(resId);
            console.log(
              `[${this.config.stationId}] Reservation ${String(resId)} consumed by authorize`,
            );
            const connId = this.getConnectorId(res.evseId > 0 ? res.evseId : evseId);
            this.evseConnectorStatus.set(res.evseId > 0 ? res.evseId : evseId, 'Available');
            void this.sendStatusNotification(
              res.evseId > 0 ? res.evseId : evseId,
              connId,
              'Available',
            ).catch(() => {});
            break;
          }
        }
      }

    // 2.1: check if same token should stop the active transaction
    if (!this.is16 && ctx.transactionId != null) {
      const startInfo = this.transactionStartTokens.get(ctx.transactionId);
      if (startInfo != null && idToken === startInfo.idToken) {
        await this.stopCharging(evseId, 'Local');
        return result;
      }
    }

    // 1.6: check if this token (or its parentIdTag) should stop an active transaction
    if (this.is16 && ctx.transactionId != null) {
      const parentIdTag = authInfo['parentIdTag'] as string | undefined;
      const startInfo = this.transactionStartTokens.get(ctx.transactionId);
      if (startInfo != null) {
        // Stop if same token or matching parentIdTag
        const startParent =
          startInfo.groupIdToken != null
            ? (startInfo.groupIdToken['idToken'] as string | undefined)
            : undefined;
        const shouldStop =
          idToken === startInfo.idToken ||
          (parentIdTag != null && startParent != null && parentIdTag === startParent);
        if (shouldStop) {
          await this.stopCharging(evseId, 'Local');
          return result;
        }
      }
    }

    // Auto-start if cable already plugged
    if (this.is16 && ctx.state === 'Preparing') {
      try {
        await this.beginTransaction(evseId, idToken, tokenType);
      } catch (err) {
        logger.warn(
          { err, stationId: this.config.stationId, evseId },
          'Auto-start of the transaction failed',
        );
      }
    } else if (!this.is16 && ctx.cablePlugged && ctx.transactionId == null) {
      // 2.1: auto-start when cable is connected and no active transaction
      try {
        await this.beginTransaction(evseId, idToken, tokenType);
      } catch (err) {
        logger.warn(
          { err, stationId: this.config.stationId, evseId },
          'Auto-start of the transaction failed',
        );
      }
    } else if (ctx.state !== 'Charging') {
      // Transition to Preparing on auth (station indicates user is identified)
      ctx.state = 'Authorized';
      if (this.is16) {
        const evse = this.config.evses.find((e) => e.evseId === evseId);
        if (evse != null) {
          this.evseConnectorStatus.set(evseId, 'Preparing');
          await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Preparing');
          this.startConnectionTimeoutTimer(evseId);
        }
      } else if (!ctx.cablePlugged) {
        // OCPP 2.1: Start EVConnectionTimeout for local authorize-first flow
        this.startEvConnectTimeoutTimerPreTx(evseId);
      }
    }

    return result;
  }

  async startCharging(
    evseId: number,
    idToken: string,
    tokenType: string = 'ISO14443',
    remoteStartId?: number,
  ): Promise<string> {
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    if (ctx.transactionId != null) {
      // Idempotent: if a transaction is already running for the same token
      // (e.g. plugIn auto-started after authorize), return its id rather than
      // throwing. Different token still throws so genuine conflicts surface.
      if (ctx.authorizedToken === idToken) {
        return ctx.transactionId;
      }
      throw new Error('Transaction already active on this EVSE');
    }

    // Skip authorize if already authorized with this token
    if (ctx.authorizedToken !== idToken) {
      let authInfo: Record<string, unknown> | undefined;
      if (!this.client.isConnected) {
        // Offline: check local auth list, then auth cache
        const localEntry = this.localAuthEntries.get(idToken);
        if (localEntry != null) {
          const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
          authInfo = { status };
        } else {
          const cached = this.cachedIdTokenInfo(idToken);
          if (cached != null) {
            authInfo = cached;
          } else {
            const allowUnknown = this.getConfigValue('AllowOfflineTxForUnknownId') === 'true';
            authInfo = { status: allowUnknown ? 'Accepted' : 'Unknown' };
          }
        }
      } else {
        const authResult = await this.sendAuthorize(idToken, tokenType);
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        authInfo = authResult[statusField] as Record<string, unknown> | undefined;
      }
      if (authInfo != null && authInfo['status'] !== 'Accepted') {
        throw new Error(`Authorization rejected: ${authInfo['status'] as string}`);
      }
      ctx.authorizedToken = idToken;
      ctx.authorizedTokenType = tokenType;
    }

    if (remoteStartId != null) ctx.remoteStartId = remoteStartId;

    // Sync in-memory cablePlugged from the reported connector status. After
    // a simulator restart the in-memory flag resets even when the connector
    // is physically plugged in per the CSMS view. Trusting the reported
    // status (across both OCPP versions and pre-charge / active-session
    // states) lets a previously-plugged station resume without reconnecting
    // the cable. Cable-not-plugged enforcement lives in the API
    // (POST /v1/css/actions/startCharging connector status pre-check) and
    // in the OCPP RequestStart/RemoteStart handlers via the
    // EVConnectionTimeOut / ConnectionTimeOut timer flow -- not here.
    const reportedStatus = this.evseConnectorStatus.get(evseId);
    const PLUGGED_REPORTED = new Set([
      // OCPP 1.6
      'Preparing',
      'Charging',
      'SuspendedEV',
      'SuspendedEVSE',
      'Finishing',
      // OCPP 2.1
      'Occupied',
      'EVConnected',
    ]);
    if (!ctx.cablePlugged && reportedStatus != null && PLUGGED_REPORTED.has(reportedStatus)) {
      ctx.cablePlugged = true;
    }

    return this.beginTransaction(evseId, idToken, tokenType, remoteStartId);
  }

  private async beginTransaction(
    evseId: number,
    idToken: string,
    tokenType: string,
    remoteStartId?: number,
    _consumedReservationId?: number,
    customTriggerReason?: string,
  ): Promise<string> {
    const ctx = this.evseContexts.get(evseId) as EvseContext;

    // Reset meter generator for this EVSE
    const gen = this.meterGens.get(evseId);
    if (gen != null) {
      gen.resetSession();
    }

    // Reset transaction-limit state BEFORE sending the Started event. The
    // CSMS response to Started can carry a transactionLimit / totalCost; the
    // simulator defers processing via setTimeout(0). If the reset ran after
    // that processing it would silently wipe the freshly-installed limits,
    // and CostLimitReached / EnergyLimitReached / TimeLimitReached would
    // never fire even though the CSMS responses were correct.
    this.evseTransactionLimits.delete(evseId);
    this.evseTotalCost.delete(evseId);
    this.evseLimitReached.delete(evseId);
    this.evseLastDriverLimits.delete(evseId);
    this.evseInvalidIdMaxEnergy.delete(evseId);
    this.evseLastLocalCost.delete(evseId);

    // Consume any reservation on this EVSE
    let consumedReservationId: number | undefined;
    for (const [id, r] of this.reservations) {
      if (r.evseId === evseId || r.evseId === 0) {
        this.clearReservationTimer(id);
        consumedReservationId = id;
        this.reservations.delete(id);
        console.log(`[${this.config.stationId}] Reservation ${String(id)} consumed by transaction`);
        break;
      }
    }

    // StatusNotification
    const connectorId = this.getConnectorId(evseId);
    const chargingStatus = this.is16 ? 'Charging' : 'Occupied';
    this.evseConnectorStatus.set(evseId, chargingStatus);
    try {
      await this.sendStatusNotification(evseId, connectorId, chargingStatus);
    } catch (err) {
      logger.debug(
        { err, stationId: this.config.stationId, evseId, connectorId, status: chargingStatus },
        'StatusNotification not delivered, the status is reported on reconnect',
      );
    }
    await this.updateEvseStatus(evseId, chargingStatus).catch(() => {});

    let txId: string;
    let startRejected = false;

    if (this.is16) {
      if (this.client.isConnected) {
        const response = await this.sendStartTransaction(evseId, idToken, consumedReservationId);
        txId = String(response['transactionId']);
      } else {
        // Queue StartTransaction for replay when back online
        txId = String(Date.now()); // Temporary local ID
        const gen2 = this.meterGens.get(evseId);
        const meterStartWh = gen2?.energyWh ?? 0;
        const startPayload: Record<string, unknown> = {
          connectorId: evseId,
          idTag: idToken,
          meterStart: meterStartWh,
          timestamp: new Date().toISOString(),
        };
        if (consumedReservationId != null) {
          startPayload['reservationId'] = consumedReservationId;
        }
        this.queueOfflineMessage('StartTransaction', startPayload, txId);
      }
    } else {
      txId = randomUUID();
      this.evseSeqNo.set(evseId, 0);
      this.evseChargingState.set(evseId, 'EVConnected');

      // Generate Transaction.Begin meter values for Started event
      const startMeasurands = this.getSampledMeasurands();
      const startSampledValues =
        gen != null
          ? gen
              .generate(startMeasurands, false)
              .map((sv) => ({ ...sv, context: 'Transaction.Begin' }))
          : [];

      const startedOpts: Parameters<typeof this.sendTransactionEvent>[2] = {
        triggerReason:
          customTriggerReason ?? (remoteStartId != null ? 'RemoteStart' : 'Authorized'),
        transactionId: txId,
        chargingState: 'EVConnected',
        idToken,
        tokenType,
      };
      // C25.FR.04-06, E16.FR.01: limits the EV driver entered for the QR code payment are
      // the station's limits for this transaction, reported once in transactionLimit.
      const enteredLimits = this.evseWebPaymentLimits.get(evseId);
      if (enteredLimits != null) {
        this.evseWebPaymentLimits.delete(evseId);
        this.evseTransactionLimits.set(evseId, { ...enteredLimits });
        startedOpts.transactionLimit = { ...enteredLimits };
      }
      this.evsePublicKeySent.delete(evseId);
      if (startSampledValues.length > 0) {
        startedOpts.meterValue = [
          this.signMeterValue(evseId, {
            timestamp: new Date().toISOString(),
            sampledValue: startSampledValues,
          }),
        ];
      }
      this.startTxEndedSampling(evseId, txId);
      const startedResponse = await this.sendTransactionEvent(evseId, 'Started', startedOpts);
      startRejected = this.isRejectedIdTokenInfo(startedResponse);
      // Follow up with Charging state (energy transfer begins), unless CSMS rejected the
      // idToken and no energy may be delivered (E05.FR.02, E05.FR.10)
      if (!startRejected || this.energyAllowedOnInvalidId()) {
        const seqNo2 = (this.evseSeqNo.get(evseId) ?? 0) + 1;
        this.evseSeqNo.set(evseId, seqNo2);
        this.evseChargingState.set(evseId, 'Charging');
        await this.sendTransactionEvent(evseId, 'Updated', {
          triggerReason: 'ChargingStateChanged',
          transactionId: txId,
          chargingState: 'Charging',
          seqNo: seqNo2,
        });
      }
    }

    // Create DB transaction record
    const meterStartWh = gen?.energyWh ?? 0;
    await this.createTransaction(evseId, txId, idToken, tokenType, meterStartWh).catch(() => {
      // DB may be unavailable
    });

    // Feature 3: Store start token and its groupId for stop-authorization checks
    const groupIdToken = this.tokenGroupMap.get(idToken) ?? null;
    this.transactionStartTokens.set(txId, { idToken, groupIdToken });

    console.log(
      `[${this.config.stationId}] Transaction started: ${txId} on EVSE ${String(evseId)}`,
    );

    // Start meter loop. Transaction-limit state was reset above, before the
    // Started event, so the deferred Started-response processing can install
    // limits without being clobbered.
    this.evseIdle.set(evseId, false);
    this.evseMeterTick.set(evseId, 0);
    this.evseTransactionStartTime.set(evseId, Date.now());
    // No energy transfer when CSMS rejected the idToken and none may be delivered (E05)
    if (!startRejected || this.energyAllowedOnInvalidId()) this.startMeterLoop(evseId);

    // Update context
    ctx.state = 'Charging';
    ctx.transactionId = txId;

    // E05: CSMS did not accept the idToken of the TransactionEvent Started
    if (startRejected) await this.handleRejectedTransactionIdToken(evseId);

    return txId;
  }

  /** A TransactionEventResponse whose idTokenInfo does not allow charging (E05). */
  private isRejectedIdTokenInfo(response: Record<string, unknown>): boolean {
    const info = response['idTokenInfo'] as Record<string, unknown> | undefined;
    return info != null && info['status'] !== 'Accepted';
  }

  /** E05.FR.03: StopTxOnInvalidId false and MaxEnergyOnInvalidId set allow some energy. */
  private energyAllowedOnInvalidId(): boolean {
    return (
      this.getConfigValue('TxCtrlr.StopTxOnInvalidId') === 'false' &&
      Number(this.getConfigValue('TxCtrlr.MaxEnergyOnInvalidId') ?? '0') > 0
    );
  }

  /**
   * OCPP 2.1 E05 / C12: CSMS answered a TransactionEventRequest with an idTokenInfo that is
   * not Accepted while the transaction is ongoing. The simulator's transaction stops when
   * the authorization ends (TxStopPoint Authorized/PowerPathClosed), so:
   * - StopTxOnInvalidId true: end the transaction, triggerReason Deauthorized, stoppedReason
   *   DeAuthorized (E05.FR.10). MaxEnergyOnInvalidId plays no role.
   * - StopTxOnInvalidId false and MaxEnergyOnInvalidId not reached: keep delivering energy
   *   until the transaction delivered that amount (E05.FR.03).
   * - Otherwise suspend: TransactionEvent Updated, ChargingStateChanged, SuspendedEVSE
   *   (E05.FR.02).
   */
  private async handleRejectedTransactionIdToken(evseId: number): Promise<void> {
    const txId = this.evseContexts.get(evseId)?.transactionId;
    if (txId == null) return;
    if (this.getConfigValue('TxCtrlr.StopTxOnInvalidId') !== 'false') {
      await this.stopCharging(evseId, 'DeAuthorized');
      return;
    }
    const maxEnergy = Number(this.getConfigValue('TxCtrlr.MaxEnergyOnInvalidId') ?? '0');
    const delivered = this.meterGens.get(evseId)?.energyWh ?? 0;
    if (maxEnergy > 0 && delivered < maxEnergy) {
      this.evseInvalidIdMaxEnergy.set(evseId, maxEnergy);
      return;
    }
    await this.suspendForInvalidId(evseId, txId);
  }

  /** E05.FR.02: stop the energy transfer, the transaction stays ongoing. */
  private async suspendForInvalidId(evseId: number, txId: string): Promise<void> {
    this.evseInvalidIdMaxEnergy.delete(evseId);
    this.stopMeterLoop(evseId);
    if (this.evseChargingState.get(evseId) === 'SuspendedEVSE') return;
    this.evseChargingState.set(evseId, 'SuspendedEVSE');
    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason: 'ChargingStateChanged',
      transactionId: txId,
      chargingState: 'SuspendedEVSE',
      seqNo,
    });
  }

  /**
   * Ends the transaction on the EVSE. The reason must be a stop reason of the station's
   * OCPP version (1.6 StopTransaction reason, 2.1 ReasonEnumType). On 2.1 the
   * triggerReason follows the reason (`endedTriggerFor21`) unless `triggerReason` is given.
   */
  async stopCharging(
    evseId: number,
    reason: string = 'Local',
    triggerReasonOverride?: string,
  ): Promise<void> {
    if (!isStopReasonFor(this.is16 ? 'ocpp1.6' : 'ocpp2.1', reason)) {
      throw new Error(
        `Stop reason ${reason} is not an OCPP ${this.is16 ? '1.6' : '2.1'} stop reason`,
      );
    }
    const tx = await this.getActiveTransaction(evseId);
    if (tx == null) {
      console.log(`[${this.config.stationId}] No active transaction on EVSE ${String(evseId)}`);
      return;
    }

    this.stopMeterLoop(evseId);

    const gen = this.meterGens.get(evseId);
    const meterStopWh = gen?.energyWh ?? 0;

    if (this.is16) {
      const stopPayload: Record<string, unknown> = {
        transactionId: Number(tx.transactionId),
        meterStop: meterStopWh,
        timestamp: new Date().toISOString(),
        reason,
      };
      stopPayload['idTag'] = tx.idToken;
      await this.sendTransactionMessage16('StopTransaction', stopPayload);
    } else {
      const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
      this.evseSeqNo.set(evseId, seqNo);
      // Map stop reason to OCPP 2.1 triggerReason and chargingState
      const mapped = endedTriggerFor21(reason);
      const triggerReason = triggerReasonOverride ?? mapped.triggerReason;
      const endChargingState = mapped.chargingState;
      // Generate Transaction.End meter values for Ended event
      const endMeasurands = this.getTxEndedMeasurands();
      const endSampledValues =
        gen != null
          ? gen.generate(endMeasurands, false).map((sv) => ({ ...sv, context: 'Transaction.End' }))
          : [];
      // Meter data collected during the transaction (TxEndedInterval)
      this.stopTxEndedSampling(evseId);
      const txEndedMeterValues = (this.evseTxEndedMeterValues.get(evseId) ?? []).map((mv) =>
        this.signMeterValue(
          evseId,
          mv as { timestamp: string; sampledValue: SampledValueRecord[] },
        ),
      );
      this.evseTxEndedMeterValues.delete(evseId);

      const endedOpts: Parameters<typeof this.sendTransactionEvent>[2] = {
        triggerReason,
        transactionId: tx.transactionId,
        chargingState: endChargingState,
        stoppedReason: reason,
        seqNo,
      };
      const endMeterValues = [...txEndedMeterValues];
      if (endSampledValues.length > 0) {
        endMeterValues.push(
          this.signMeterValue(evseId, {
            timestamp: new Date().toISOString(),
            sampledValue: endSampledValues,
          }),
        );
      }
      if (endMeterValues.length > 0) {
        endedOpts.meterValue = endMeterValues;
      }
      await this.sendTransactionEvent(evseId, 'Ended', endedOpts);
      // N07: the energy transfer stopped, the EVSE Power is 0 now
      this.dispatchMonitorEvents(
        this.evaluateMonitors({ name: 'EVSE', evse: { id: evseId } }, 'Power', 0, tx.transactionId),
      );
    }

    console.log(
      `[${this.config.stationId}] Transaction stopped: ${tx.transactionId} (${String(meterStopWh)} Wh)`,
    );

    // Complete DB record
    await this.completeTransaction(tx.transactionId, reason, meterStopWh);

    // Clean up start token tracking (Feature 3)
    this.transactionStartTokens.delete(tx.transactionId);

    // Reset per-EVSE state
    this.evsePowerLimits.set(evseId, null);
    this.evseIdle.set(evseId, false);
    this.evseChargingState.set(evseId, null);
    this.evseSeqNo.set(evseId, 0);
    this.evseMeterTick.set(evseId, 0);
    this.evseTransactionLimits.delete(evseId);
    this.evseTotalCost.delete(evseId);
    this.evseTransactionStartTime.delete(evseId);
    this.evseLimitReached.delete(evseId);
    this.evseLastDriverLimits.delete(evseId);
    this.evseInvalidIdMaxEnergy.delete(evseId);
    this.evseLastLocalCost.delete(evseId);

    // Update EvseContext
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    ctx.transactionId = null;
    ctx.authorizedToken = null;
    ctx.authorizedTokenType = null;
    ctx.remoteStartId = null;

    // Transition status after stop. A scheduled ChangeAvailability(Inoperative)
    // that returned Scheduled while this transaction was running must be applied
    // now that the blocking transaction has ended: the EVSE rests at Unavailable
    // instead of Finishing/Occupied. hasAnyActiveTransaction guards the case
    // where another EVSE on the station is still mid-transaction.
    const connectorId = this.getConnectorId(evseId);
    const applyScheduledDown =
      this.isEvseAdminUnavailable(evseId) && !(await this.hasAnyActiveTransaction());

    if (applyScheduledDown) {
      ctx.state = 'Unavailable';
      this.evseConnectorStatus.set(evseId, 'Unavailable');
      const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
      this.evseSeqNo.set(evseId, seqNo);
      this.evseChargingState.set(evseId, 'Idle');
      try {
        await this.sendStatusNotification(evseId, connectorId, 'Unavailable');
      } catch (err) {
        logger.debug(
          { err, stationId: this.config.stationId, evseId, connectorId, status: 'Unavailable' },
          'StatusNotification not delivered, the status is reported on reconnect',
        );
      }
      await this.updateEvseStatus(evseId, 'Unavailable').catch(() => {});
    } else if (this.is16) {
      // 1.6: send Finishing (cable still connected), Available comes on unplug
      ctx.state = 'Finishing';
      this.evseConnectorStatus.set(evseId, 'Finishing');
      try {
        await this.sendStatusNotification(evseId, connectorId, 'Finishing');
      } catch (err) {
        logger.debug(
          { err, stationId: this.config.stationId, evseId, connectorId, status: 'Finishing' },
          'StatusNotification not delivered, the status is reported on reconnect',
        );
      }
      await this.updateEvseStatus(evseId, 'Finishing').catch(() => {});
    } else {
      // OCPP 2.1: connectorStatus has been Occupied since plug-in and stays
      // Occupied until unplug -- no StatusNotification is due here, the
      // status hasn't changed. The post-stop chargingState (EVConnected)
      // was already reported on the TransactionEvent Ended emitted above.
      // The unplug() method handles the eventual transition to Available.
      ctx.state = 'EVConnected';
      this.evseConnectorStatus.set(evseId, 'Occupied');
      const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
      this.evseSeqNo.set(evseId, seqNo);
      this.evseChargingState.set(evseId, 'EVConnected');
      await this.updateEvseStatus(evseId, 'Occupied').catch(() => {});
    }

    // Handle pending reset
    if (this.pendingReset != null) {
      const resetType = this.pendingReset;
      this.pendingReset = null;
      void this.simulateReset(resetType).catch(() => {});
    }
  }

  async unplug(evseId: number): Promise<void> {
    const ctx = this.evseContexts.get(evseId) as EvseContext;

    // No-op only when there is genuinely nothing to do: no cable, no active
    // transaction, AND the connector is already reporting Available. After a
    // simulator restart the in-memory state resets but the CSMS may still
    // hold the connector in Finishing from a previous stop -- in that case
    // we must let unplug proceed so a StatusNotification(Available) is sent
    // to clear the state.
    if (
      !ctx.cablePlugged &&
      ctx.transactionId == null &&
      this.evseConnectorStatus.get(evseId) === 'Available'
    ) {
      return;
    }

    ctx.cablePlugged = false;
    const connectorId = this.getConnectorId(evseId);

    // If a transaction is active, check StopTransactionOnEVSideDisconnect
    if (ctx.transactionId != null) {
      const stopOnDisconnect = this.is16
        ? this.configVariables.get('StopTransactionOnEVSideDisconnect')?.value !== 'false'
        : this.configVariables.get('TxCtrlr.StopTxOnEVSideDisconnect')?.value !== 'false';

      if (stopOnDisconnect) {
        // Stop the transaction and send Available (clamped to Unavailable when
        // the operator scheduled a ChangeAvailability(Inoperative)).
        await this.stopCharging(evseId, 'EVDisconnected');
        await this.restoreConnectorStatus(evseId, connectorId, 'Available');
      } else if (!this.is16) {
        // OCPP 2.1: Suspend the transaction - send TransactionEvent Updated
        // with EVCommunicationLost and chargingState Idle
        this.stopMeterLoop(evseId);
        const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
        this.evseSeqNo.set(evseId, seqNo);
        this.evseChargingState.set(evseId, 'Idle');
        ctx.state = 'SuspendedEV';
        await this.sendTransactionEvent(evseId, 'Updated', {
          triggerReason: 'EVCommunicationLost',
          transactionId: ctx.transactionId,
          chargingState: 'Idle',
          seqNo,
        });
        // Send StatusNotification Available (cable disconnected); clamped to
        // Unavailable when administratively down. ctx.state stays SuspendedEV
        // because the transaction is suspended, not ended.
        const disconnectedStatus = clampStatusForAdminAvailability(
          'Available',
          this.isEvseAdminUnavailable(evseId),
        );
        this.evseConnectorStatus.set(evseId, disconnectedStatus);
        try {
          await this.sendStatusNotification(evseId, connectorId, disconnectedStatus);
        } catch (err) {
          logger.debug(
            {
              err,
              stationId: this.config.stationId,
              evseId,
              connectorId,
              status: disconnectedStatus,
            },
            'StatusNotification not delivered, the status is reported on reconnect',
          );
        }
        await this.updateEvseStatus(evseId, disconnectedStatus).catch(() => {});

        // Start EVConnectionTimeout timer for the suspended transaction.
        // If cable is not re-plugged within the timeout, end the transaction.
        this.startEvConnectTimeoutTimer(evseId, ctx.transactionId);
      } else {
        // 1.6: Suspend the transaction (EV disconnected but tx continues).
        // Clamp to Unavailable when administratively down.
        const suspendStatus = clampStatusForAdminAvailability(
          'SuspendedEV',
          this.isEvseAdminUnavailable(evseId),
        );
        ctx.state = suspendStatus;
        this.evseConnectorStatus.set(evseId, suspendStatus);
        try {
          await this.sendStatusNotification(evseId, connectorId, suspendStatus);
        } catch (err) {
          logger.debug(
            { err, stationId: this.config.stationId, evseId, connectorId, status: suspendStatus },
            'StatusNotification not delivered, the status is reported on reconnect',
          );
        }
        await this.updateEvseStatus(evseId, suspendStatus).catch(() => {});
      }
    } else {
      // No active transaction - just go to Available (clamped to Unavailable
      // when the operator has the EVSE administratively down).
      ctx.authorizedToken = null;
      ctx.authorizedTokenType = null;
      await this.restoreConnectorStatus(evseId, connectorId, 'Available');
    }
  }

  /**
   * OCPP 2.1: Simulate the EV departing the parking bay. Sends TransactionEvent Ended
   * with triggerReason EVDeparted and stoppedReason Local (EVDeparted is a trigger
   * reason, not a ReasonEnumType value).
   */
  async departParkingBay(evseId: number): Promise<void> {
    if (this.is16) return;
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    if (ctx.transactionId == null) return;
    await this.stopCharging(evseId, 'Local', 'EVDeparted');
  }

  /**
   * OCPP 2.1: Simulate parking bay becoming occupied (vehicle detected).
   * Sends TransactionEvent Started with triggerReason ParkingBayOccupancy.
   */
  async occupyParkingBay(evseId: number, idToken: string): Promise<void> {
    if (this.is16) return;
    await this.beginTransaction(
      evseId,
      idToken,
      'ISO14443',
      undefined,
      undefined,
      'ParkingBayOccupancy',
    );
  }

  /** The suspended state of the EVSE's transaction, or null while it charges. */
  private suspendedState(evseId: number): 'SuspendedEV' | 'SuspendedEVSE' | null {
    const state = this.is16
      ? this.evseConnectorStatus.get(evseId)
      : this.evseChargingState.get(evseId);
    return state === 'SuspendedEV' || state === 'SuspendedEVSE' ? state : null;
  }

  /**
   * The EV (`by: 'EV'`) or the EVSE (`by: 'EVSE'`) stops the energy transfer while the
   * transaction and the cable stay. The meter loop keeps running at power 0 with flat
   * energy. 2.1: TransactionEvent Updated, ChargingStateChanged, chargingState
   * SuspendedEV or SuspendedEVSE. 1.6: StatusNotification SuspendedEV or SuspendedEVSE.
   * A no-op without a transaction or when it is already suspended by the same party.
   */
  async suspendCharging(evseId: number, by: 'EV' | 'EVSE'): Promise<void> {
    const ctx = this.evseContexts.get(evseId);
    if (ctx?.transactionId == null) return;
    if (this.evseConnectorStatus.get(evseId) === 'Faulted') {
      throw new Error('Cannot suspend charging while the connector is faulted');
    }
    const target = by === 'EV' ? 'SuspendedEV' : 'SuspendedEVSE';
    if (this.suspendedState(evseId) === target) return;
    // State first, so a send that fails offline leaves the meter consistent
    this.evseIdle.set(evseId, true);
    await this.reportChargingState(evseId, ctx.transactionId, target);
  }

  /**
   * The energy transfer starts again after suspendCharging (or a cleared fault, or a
   * transaction resumed as SuspendedEVSE). Refused while the connector is faulted, a
   * transaction limit is reached, or the cable is out. A no-op without a transaction
   * or while it charges.
   */
  async resumeCharging(evseId: number): Promise<void> {
    const ctx = this.evseContexts.get(evseId);
    if (ctx?.transactionId == null) return;
    if (this.evseConnectorStatus.get(evseId) === 'Faulted') {
      throw new Error('Cannot resume charging while the connector is faulted');
    }
    if (this.evseLimitReached.get(evseId) ?? false) {
      throw new Error('Cannot resume charging after a transaction limit was reached');
    }
    if (!ctx.cablePlugged) {
      throw new Error('Cannot resume charging without the cable plugged in');
    }
    const meterRunning = this.meterTimers.has(evseId);
    if (this.suspendedState(evseId) == null && meterRunning) return;
    this.evseIdle.set(evseId, false);
    if (this.suspendedState(evseId) != null) {
      await this.reportChargingState(evseId, ctx.transactionId, 'Charging');
    }
    if (!this.meterTimers.has(evseId)) this.startMeterLoop(evseId);
  }

  /** Reports a charging state change of a running transaction (1.6 as connector status). */
  private async reportChargingState(evseId: number, txId: string, state: string): Promise<void> {
    if (this.is16) {
      const connectorId = this.getConnectorId(evseId);
      this.evseConnectorStatus.set(evseId, state);
      try {
        await this.sendStatusNotification(evseId, connectorId, state);
      } catch (err) {
        logger.debug(
          { err, stationId: this.config.stationId, evseId, connectorId, status: state },
          'StatusNotification not delivered, the status is reported on reconnect',
        );
      }
      await this.updateEvseStatus(evseId, state).catch(() => {});
      return;
    }
    this.evseChargingState.set(evseId, state);
    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason: 'ChargingStateChanged',
      transactionId: txId,
      chargingState: state,
      seqNo,
    });
  }

  /**
   * The EV battery is full. 2.1: SuspendedEV, then TransactionEvent Ended with
   * stoppedReason SOCLimitReached (triggerReason SoCLimitReached). 1.6: SuspendedEV, then
   * the EV unplugs. A no-op without a transaction.
   */
  async evFull(evseId: number): Promise<void> {
    const ctx = this.evseContexts.get(evseId);
    if (ctx?.transactionId == null) return;
    await this.suspendCharging(evseId, 'EV');
    if (this.is16) {
      await this.unplug(evseId);
    } else {
      await this.stopCharging(evseId, 'SOCLimitReached');
    }
  }

  // ---------------------------------------------------------------------------
  // Group 2: Fault injection
  // ---------------------------------------------------------------------------

  /**
   * The connector reports Faulted. With a transaction, `mode: 'end'` (default) ends it
   * with the fault's stop reason (`faultStopReason`; 2.1 triggerReason
   * AbnormalCondition), `mode: 'suspend'` keeps it suspended by the EVSE with no
   * energy (2.1: chargingState SuspendedEVSE) until clearFault and resumeCharging.
   */
  async injectFault(
    evseId: number,
    errorCode: string,
    mode: 'end' | 'suspend' = 'end',
  ): Promise<void> {
    const faultCtx = this.evseContexts.get(evseId) as EvseContext;

    // No-op if connector is already Faulted. Re-firing would duplicate the
    // StatusNotification and re-stop a transaction that no longer exists.
    if (this.evseConnectorStatus.get(evseId) === 'Faulted') {
      return;
    }

    const keepTransaction = mode === 'suspend' && faultCtx.transactionId != null;
    if (keepTransaction) {
      this.evseIdle.set(evseId, true);
      if (!this.is16 && this.evseChargingState.get(evseId) !== 'SuspendedEVSE') {
        await this.reportChargingState(evseId, faultCtx.transactionId as string, 'SuspendedEVSE');
      }
    } else if (faultCtx.transactionId != null) {
      await this.stopCharging(
        evseId,
        faultStopReason(this.is16 ? 'ocpp1.6' : 'ocpp2.1', errorCode),
      );
    }
    const connectorId = this.getConnectorId(evseId);
    this.evseConnectorStatus.set(evseId, 'Faulted');
    if (!keepTransaction) faultCtx.state = 'Faulted';
    await this.sendStatusNotification(evseId, connectorId, 'Faulted', errorCode);
    await this.updateEvseStatus(evseId, 'Faulted');
  }

  /**
   * Physical action: the EV driver pushes the plug in only halfway, so the
   * connector lock cannot engage. The station reports ConnectorLockFailure and
   * does not start the transaction a pending authorization was waiting for.
   */
  async plugInHalfway(evseId: number): Promise<void> {
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    ctx.cablePlugged = true;
    ctx.authorizedToken = null;
    ctx.authorizedTokenType = null;
    ctx.remoteStartId = null;
    this.cancelConnectionTimeoutTimer(evseId);
    this.cancelEvConnectTimeoutTimer(evseId);
    await this.injectFault(evseId, 'ConnectorLockFailure');
  }

  /** Simulated hardware fault: the connector lock is jammed, so unlocking fails. */
  jamConnectorLock(evseId: number): void {
    this.jammedLocks.add(evseId);
  }

  async clearFault(evseId: number): Promise<void> {
    // No-op if connector is not currently Faulted. Without this guard,
    // clearFault on an Available/Charging connector would force it back
    // to Available and mask the real state.
    if (this.evseConnectorStatus.get(evseId) !== 'Faulted') {
      return;
    }

    const connectorId = this.getConnectorId(evseId);
    const clearCtx = this.evseContexts.get(evseId) as EvseContext;
    // A transaction kept through the fault stays suspended by the EVSE: the connector
    // is occupied again (1.6 SuspendedEVSE) and resumeCharging restarts the energy.
    const status = clampStatusForAdminAvailability(
      clearCtx.transactionId != null ? (this.is16 ? 'SuspendedEVSE' : 'Occupied') : 'Available',
      this.isEvseAdminUnavailable(evseId),
    );
    this.evseConnectorStatus.set(evseId, status);
    if (clearCtx.transactionId == null) clearCtx.state = 'Available';
    await this.sendStatusNotification(evseId, connectorId, status);
    await this.updateEvseStatus(evseId, status);
  }

  // ---------------------------------------------------------------------------
  // Plug and Charge (ISO 15118, OCPP 2.1 M01 and C07)
  // ---------------------------------------------------------------------------

  /**
   * The EV plugged into the EVSE gets an OEM provisioning certificate (CN = PCID).
   * Returns the PCID and the OEM root PEM, which the CSMS needs as an OEMRootCertificate
   * to accept the EV's CertificateInstallationReq. A new EV replaces the previous one
   * and its contract. Held in memory: a simulator restart forgets it.
   */
  async createPncEv(
    evseId: number,
    edition: Edition = 2,
  ): Promise<{ pcid: string; oemRootCertificate: string; edition: Edition }> {
    this.requirePnc(evseId);
    const ev = await TestEv.create(edition, randomPcid('EVSIM'), 'EVtivity Simulator');
    this.pncEvs.set(evseId, { ev, contract: null });
    return { pcid: ev.pcid, oemRootCertificate: ev.oemRoot.toString('pem'), edition };
  }

  /**
   * The EV installs a contract (M01): Get15118EVCertificate with action Install and the
   * EV's signed CertificateInstallationReq. The station accepts the contract only when the
   * response is Accepted and the EV's checks pass (response code, CPS signature, contract
   * certificate, decrypted private key). Returns the eMAID.
   */
  async installPncContract(
    evseId: number,
  ): Promise<{ emaid: string; remainingContracts: number | null }> {
    this.requirePnc(evseId);
    const entry = this.pncEvs.get(evseId);
    if (entry == null) throw new Error('No Plug and Charge EV on this EVSE, create one first');
    const response = await this.sendGet15118EVCertificate(
      entry.ev.namespace,
      'Install',
      entry.ev.installationRequest(),
    );
    const exi = response['exiResponse'];
    if (response['status'] !== 'Accepted' || typeof exi !== 'string' || exi === '') {
      throw new Error(
        `Get15118EVCertificate was not accepted (status ${String(response['status'])})`,
      );
    }
    const check =
      entry.ev.edition === 2
        ? checkIso2Response(exi, 'CertificateInstallationRes', entry.ev.oemKey)
        : checkIso20Response(exi, entry.ev);
    if (!check.ok) throw new Error(`The EV refused the contract: ${check.reason}`);
    this.pncEvs.set(evseId, { ev: entry.ev, contract: check.contract });
    const remaining =
      typeof response['remainingContracts'] === 'number'
        ? response['remainingContracts']
        : check.remaining;
    return { emaid: check.contract.emaid, remainingContracts: remaining };
  }

  /**
   * Plug and Charge start (C07): Authorize with the contract's eMAID (type eMAID) and the
   * iso15118CertificateHashData of its certificate chain, then the transaction starts with
   * the eMAID. Needs the cable plugged in and the station online (the CSMS validates the
   * contract certificate). Returns the transaction id.
   */
  async startPncCharging(evseId: number): Promise<string> {
    this.requirePnc(evseId);
    const contract = this.pncEvs.get(evseId)?.contract;
    if (contract == null) throw new Error('No contract installed, install one first');
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    if (!ctx.cablePlugged) throw new Error('Plug and Charge needs the cable plugged in');
    if (ctx.transactionId != null) {
      if (ctx.authorizedToken === contract.emaid) return ctx.transactionId;
      throw new Error('Transaction already active on this EVSE');
    }
    if (!this.client.isConnected) {
      throw new Error('Plug and Charge needs the station online');
    }
    const response = await this.client.sendCall('Authorize', {
      idToken: { idToken: contract.emaid, type: 'eMAID' },
      iso15118CertificateHashData: contractCertificateHashData(contract),
    });
    const info = response['idTokenInfo'] as Record<string, unknown> | undefined;
    if (info != null) this.cacheIdTokenInfo(contract.emaid, info);
    if (info?.['status'] !== 'Accepted') {
      throw new Error(`Authorization rejected: ${String(info?.['status'])}`);
    }
    ctx.authorizedToken = contract.emaid;
    ctx.authorizedTokenType = 'eMAID';
    return this.beginTransaction(evseId, contract.emaid, 'eMAID');
  }

  /** Plug and Charge is OCPP 2.1 only and needs a known EVSE. */
  private requirePnc(evseId: number): void {
    if (this.is16) throw new Error('Plug and Charge needs an OCPP 2.1 station');
    if (!this.evseContexts.has(evseId)) throw new Error(`Unknown EVSE ${String(evseId)}`);
  }

  // ---------------------------------------------------------------------------
  // Group 3: Network
  // ---------------------------------------------------------------------------

  /**
   * Lose the connection without losing power. Transactions, cable and EVSE
   * state stay; the meter loops keep running, and the transaction messages
   * generated while offline queue in order (2.1 E11.FR.01 TransactionEvent
   * with offline true; 1.6 StartTransaction, MeterValues with a transactionId,
   * StopTransaction). comeOnline replays them.
   */
  async goOffline(): Promise<void> {
    // No-op if already offline. Avoids redundant DB writes and disconnect
    // calls when chaos repeatedly picks goOffline on the same station.
    if (this.offlineFlag) {
      return;
    }
    this.offlineFlag = true;
    // The offline period starts now, not when the socket's close event arrives,
    // so the reconnect reports the statuses that changed since (B04.FR.02).
    if (this.offlineSince == null) {
      this.offlineSince = Date.now();
      this.statusesAtDisconnect = new Map(this.deliveredConnectorStatus);
    }
    this.client.disconnect();
    await this.updateStationStatus('disconnected');
  }

  /**
   * Re-send BootNotification and, on Accepted, emit StatusNotification for
   * each EVSE so the CSMS auto-discovers connectors. Used after a station's
   * onboarding is approved on the server side -- avoids waiting for the next
   * client-side retry tick. Lighter than simulateReset(): does not stop
   * active transactions or transition through Unavailable.
   */
  async rebootStation(): Promise<void> {
    if (!this.client.isConnected) {
      return;
    }
    try {
      await this.sendBootNotification('RemoteReset');
    } catch (err) {
      logger.warn(
        { err, stationId: this.config.stationId },
        'BootNotification for the remote reset failed, reboot stopped',
      );
      return;
    }
    if (this.bootStatus !== 'Accepted') return;

    try {
      await this.sendChargePointStatus16();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.config.stationId}] Connector 0 StatusNotification failed: ${msg}`);
    }
    for (const evse of this.config.evses) {
      const ctx = this.evseContexts.get(evse.evseId) as EvseContext;
      // Don't disturb a connector that's mid-transaction.
      if (ctx.transactionId != null) continue;
      ctx.state = 'Available';
      ctx.cablePlugged = false;
      this.evseConnectorStatus.set(evse.evseId, 'Available');
      try {
        await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Available');
      } catch (err) {
        logger.debug(
          {
            err,
            stationId: this.config.stationId,
            evseId: evse.evseId,
            connectorId: evse.connectorId,
            status: 'Available',
          },
          'StatusNotification not delivered, the status is reported on reconnect',
        );
      }
      await this.updateEvseStatus(evse.evseId, 'Available').catch(() => {});
    }
    await this.updateStationStatus('available');
  }

  /**
   * Restore the connection after goOffline. The station did not lose power, so
   * it does not boot again (1.6 4.2, 2.1 B01.FR.01 and B04): it reports its
   * actual connector statuses and replays the queued messages in order with
   * their original timestamps (resumeAfterConnectionLoss). A station that never
   * finished its first boot, or was stopped, starts from power-up instead.
   */
  async comeOnline(): Promise<void> {
    // No-op if already online: a healthy station has nothing to resume.
    if (!this.offlineFlag && this.client.isConnected) {
      return;
    }
    this.offlineFlag = false;
    // The self-heal watchdog skips a deliberately offline station, but the
    // not-ready clock kept running through the offline period, so the station
    // counted as stuck the moment it came back and was restarted in the middle
    // of its queue replay (finding JB-5). The grace period starts again now.
    if (!this.ready) this.notReadySince = Date.now();
    if (this.destroyed || !this.initialBootDone) {
      await this.start();
      return;
    }
    await this.client.connect();
    await this.onReconnect();
  }

  // ---------------------------------------------------------------------------
  // Group 4: Station-initiated OCPP messages
  // ---------------------------------------------------------------------------

  // Accepted after Pending or Rejected: report the connectors, which the station
  // could not do while it was not accepted.
  private async reportConnectorsAfterAccept(): Promise<void> {
    await this.sendChargePointStatus16();
    for (const evse of this.config.evses) {
      const ctx = this.evseContexts.get(evse.evseId) as EvseContext;
      ctx.state = 'Available';
      ctx.cablePlugged = false;
      this.evseConnectorStatus.set(evse.evseId, 'Available');
      await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Available');
      await this.updateEvseStatus(evse.evseId, 'Available');
    }
    await this.updateStationStatus('available');
  }

  private clearBootRetry(): void {
    if (this.bootRetryTimer != null) {
      clearTimeout(this.bootRetryTimer);
      this.bootRetryTimer = null;
    }
  }

  async sendBootNotification(reason: string = 'PowerUp'): Promise<Record<string, unknown>> {
    this.clearBootRetry();
    const payload = this.is16
      ? {
          chargePointVendor: this.config.vendorName,
          chargePointModel: this.config.model,
          chargePointSerialNumber: this.config.serialNumber,
          firmwareVersion: this.config.firmwareVersion,
        }
      : {
          chargingStation: {
            vendorName: this.config.vendorName,
            model: this.config.model,
            serialNumber: this.config.serialNumber,
            firmwareVersion: this.config.firmwareVersion,
          },
          reason,
        };

    const response = await this.client.sendCall('BootNotification', payload);
    this.bootStatus = response['status'] as 'Accepted' | 'Pending' | 'Rejected';
    console.log(`[${this.config.stationId}] Boot status: ${response['status'] as string}`);

    if (response['status'] === 'Accepted') {
      const interval = (response['interval'] as number) * 1000;
      this.startHeartbeat(interval > 0 ? interval : 300_000);

      // Update DB
      await this.sql`
        UPDATE css_stations
        SET boot_reason = ${reason}, last_boot_at = NOW(), updated_at = NOW()
        WHERE id = ${this.config.id}
      `;
    } else if (response['status'] === 'Pending' || response['status'] === 'Rejected') {
      // Per OCPP spec: station must retry BootNotification after the interval.
      // During Pending/Rejected, the station must not send other OCPP messages
      // (except responses to CSMS-initiated commands).
      const interval = response['interval'] as number | undefined;
      const retryIntervalMs = (interval != null ? interval : 60) * 1000;
      if (!this.destroyed) {
        this.bootRetryTimer = setTimeout(() => {
          this.bootRetryTimer = null;
          if (!this.destroyed) {
            void (async () => {
              try {
                await this.sendBootNotification(reason);
                if (this.bootStatus === 'Accepted') await this.reportConnectorsAfterAccept();
              } catch (err) {
                logger.warn(
                  { err, stationId: this.config.stationId, reason },
                  'BootNotification retry failed',
                );
              }
            })();
          }
        }, retryIntervalMs);
      }
    }

    return response;
  }

  async sendHeartbeat(): Promise<Record<string, unknown>> {
    const response = await this.client.sendCall('Heartbeat', {});
    console.log(`[${this.config.stationId}] Heartbeat: ${response['currentTime'] as string}`);

    await this.sql`
      UPDATE css_stations SET last_heartbeat_at = NOW(), updated_at = NOW()
      WHERE id = ${this.config.id}
    `;

    return response;
  }

  // OCPP 1.6 errata 3.22: after an accepted boot the charge point reports
  // connector 0 (the charge point itself) before its connectors.
  private async sendChargePointStatus16(): Promise<void> {
    if (!this.is16) return;
    const down =
      this.availabilityState === 'Inoperative' || this.availabilityState === 'Unavailable';
    await this.sendStatusNotification(0, 0, down ? 'Unavailable' : 'Available');
  }

  /**
   * Report a connector status. OCPP 2.1 also evaluates the monitors on the
   * Connector and EVSE AvailabilityState (N07) and sends their events after
   * the status report, queueing them offline per OfflineQueuingSeverity.
   */
  async sendStatusNotification(
    evseId: number,
    connectorId: number,
    status: string,
    errorCode?: string,
  ): Promise<void> {
    if (this.is16) {
      await this.client.sendCall('StatusNotification', {
        connectorId: evseId,
        errorCode: errorCode ?? 'NoError',
        status,
      });
      this.deliveredConnectorStatus.set(evseId, status);
    } else {
      const transactionId = this.getActiveTransactionSync(evseId);
      const monitorEvents = [
        ...this.evaluateMonitors(
          { name: 'Connector', evse: { id: evseId, connectorId } },
          'AvailabilityState',
          status,
          transactionId,
        ),
        ...this.evaluateMonitors(
          { name: 'EVSE', evse: { id: evseId } },
          'AvailabilityState',
          status,
          transactionId,
        ),
      ];
      try {
        await this.reportConnectorStatus(evseId, connectorId, status);
      } finally {
        this.dispatchMonitorEvents(monitorEvents);
      }
    }
    console.log(
      `[${this.config.stationId}] StatusNotification: EVSE ${String(evseId)} connector ${String(connectorId)} = ${status}`,
    );
  }

  private async reportConnectorStatus(
    evseId: number,
    connectorId: number,
    status: string,
  ): Promise<void> {
    const reporting =
      this.configVariables.get(CSS_STATUS_REPORTING_KEY)?.value ?? CSS_STATUS_REPORTING_DEFAULT;
    if (reporting !== 'NotifyEvent') {
      await this.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: status,
        evseId,
        connectorId,
      });
      this.deliveredConnectorStatus.set(evseId, status);
    }
    if (reporting !== 'StatusNotification') {
      const notifyEvent = this.client.sendCall('NotifyEvent', {
        generatedAt: new Date().toISOString(),
        seqNo: 0,
        tbc: false,
        eventData: [
          {
            eventId: Math.floor(Math.random() * 1000000),
            timestamp: new Date().toISOString(),
            trigger: 'Delta',
            actualValue: status,
            eventNotificationType: 'HardWiredMonitor',
            component: { name: 'Connector', evse: { id: evseId, connectorId } },
            variable: { name: 'AvailabilityState' },
          },
        ],
      });
      if (reporting === 'NotifyEvent') {
        // The only status report, so a failure propagates like StatusNotification's.
        await notifyEvent;
        this.deliveredConnectorStatus.set(evseId, status);
      } else {
        try {
          await notifyEvent;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.config.stationId}] AvailabilityState NotifyEvent failed: ${msg}`);
        }
      }
    }
  }

  // True when the station or the specific EVSE is administratively down, so a
  // status that would contradict that (Available/Occupied/etc.) must clamp to
  // Unavailable. evseAdminUnavailable is the authoritative per-EVSE flag set by
  // the ChangeAvailability handler; the connector-status check is a fallback for
  // paths that set Unavailable without going through that handler.
  private isEvseAdminUnavailable(evseId: number): boolean {
    return (
      this.availabilityState === 'Inoperative' ||
      this.availabilityState === 'Unavailable' ||
      this.evseAdminUnavailable.has(evseId) ||
      this.evseConnectorStatus.get(evseId) === 'Unavailable'
    );
  }

  // Apply a post-transaction resting status (unplug, EV-disconnect, etc.),
  // clamping it to Unavailable when the EVSE is administratively down so the
  // restoration never contradicts a pending ChangeAvailability(Inoperative).
  // Updates ctx.state, the connector-status map, the wire, and css_evses
  // together so reported and tracked state agree. Returns the applied status.
  private async restoreConnectorStatus(
    evseId: number,
    connectorId: number,
    desired: string,
  ): Promise<string> {
    const applied = clampStatusForAdminAvailability(desired, this.isEvseAdminUnavailable(evseId));
    const ctx = this.evseContexts.get(evseId) as EvseContext;
    ctx.state = applied;
    this.evseConnectorStatus.set(evseId, applied);
    try {
      await this.sendStatusNotification(evseId, connectorId, applied);
    } catch (err) {
      logger.debug(
        { err, stationId: this.config.stationId, evseId, connectorId, status: applied },
        'StatusNotification not delivered, the status is reported on reconnect',
      );
    }
    await this.updateEvseStatus(evseId, applied).catch(() => {});
    return applied;
  }

  // Public action entry for chaos/manual StatusNotification triggers. Internal
  // callers (boot, reset, ChangeAvailability, transaction lifecycle) use
  // sendStatusNotification directly and manage their own state ordering. This
  // path clamps a requested status that would contradict administrative
  // unavailability down to Unavailable BEFORE the wire send and the css_evses
  // write, so reported state and internal state stay consistent.
  async dispatchStatusNotification(
    evseId: number,
    connectorId: number,
    status: string,
    errorCode?: string,
  ): Promise<void> {
    const clamped = clampStatusForAdminAvailability(status, this.isEvseAdminUnavailable(evseId));
    this.evseConnectorStatus.set(evseId, clamped);
    await this.sendStatusNotification(evseId, connectorId, clamped, errorCode);
    await this.updateEvseStatus(evseId, clamped).catch(() => {});
  }

  async sendMeterValues(
    evseId: number,
    sampledValues?: Array<Record<string, unknown>>,
    transactionId?: string,
  ): Promise<void> {
    // If no sampled values provided, generate them from the meter value generator
    if (sampledValues == null) {
      const gen = this.meterGens.get(evseId);
      if (gen != null) {
        const idle = this.evseIdle.get(evseId) ?? false;
        const powerLimit = this.evsePowerLimits.get(evseId) ?? null;
        gen.tick(idle, powerLimit);
        const measurands = this.getSampledMeasurands();
        sampledValues = gen.generate(measurands, this.is16) as unknown as Array<
          Record<string, unknown>
        >;
      } else {
        sampledValues = [];
      }
    }
    if (this.is16) {
      const mv: Record<string, unknown> = {
        connectorId: evseId,
        meterValue: [{ timestamp: new Date().toISOString(), sampledValue: sampledValues }],
      };
      if (transactionId != null) {
        mv['transactionId'] = Number(transactionId);
        // Transaction-related: queued offline and delivered in order.
        await this.sendTransactionMessage16('MeterValues', mv);
        return;
      }
      await this.client.sendCall('MeterValues', mv);
    } else {
      await this.client.sendCall('MeterValues', {
        evseId,
        meterValue: [{ timestamp: new Date().toISOString(), sampledValue: sampledValues }],
      });
    }
  }

  async sendAuthorize(
    idToken: string,
    tokenType: string = 'ISO14443',
  ): Promise<Record<string, unknown>> {
    // LocalPreAuthorize: check local list and cache before sending to CS
    const localPreAuth = this.is16
      ? this.getConfigValue('LocalPreAuthorize') === 'true'
      : this.getConfigValue('AuthCtrlr.LocalPreAuthorize') === 'true';
    if (localPreAuth) {
      const localEntry = this.localAuthEntries.get(idToken);
      if (localEntry != null) {
        const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
        // Local auth list takes absolute priority over cache (any status)
        console.log(`[${this.config.stationId}] Authorize (local pre-auth/list): ${status}`);
        const sf = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [sf]: { status } };
      }
      const cached = this.cachedIdTokenInfo(idToken);
      if (cached != null) {
        const status = cached['status'] as string;
        if (status === 'Accepted') {
          console.log(`[${this.config.stationId}] Authorize (local pre-auth/cache): ${status}`);
          const sf = this.is16 ? 'idTagInfo' : 'idTokenInfo';
          return { [sf]: cached };
        }
      }
    }

    // LocalAuthListCtrlr.DisablePostAuthorize: if token is in local auth list (any status),
    // use the local result without sending Authorize to CSMS
    if (!this.is16 && this.getConfigValue('LocalAuthListCtrlr.DisablePostAuthorize') === 'true') {
      const localEntry = this.localAuthEntries.get(idToken);
      if (localEntry != null) {
        const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
        console.log(
          `[${this.config.stationId}] Authorize (LocalAuthList DisablePostAuthorize): ${status}`,
        );
        return { idTokenInfo: { status } };
      }
    }

    // DisablePostAuthorize: if token is cached (any status), do not send to CSMS
    if (!this.is16 && this.getConfigValue('AuthCacheCtrlr.DisablePostAuthorize') === 'true') {
      const cached = this.cachedIdTokenInfo(idToken);
      if (cached != null) {
        const status = cached['status'] as string;
        console.log(
          `[${this.config.stationId}] Authorize (DisablePostAuthorize/cached): ${status}`,
        );
        return { idTokenInfo: cached };
      }
    }

    // Offline fallback: check local auth list, then auth cache
    if (!this.client.isConnected) {
      const localEntry = this.localAuthEntries.get(idToken);
      if (localEntry != null) {
        const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
        console.log(`[${this.config.stationId}] Authorize (offline/local): ${status}`);
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [statusField]: { status } };
      }
      const cached = this.cachedIdTokenInfo(idToken);
      if (cached != null) {
        const status = cached['status'] as string;
        console.log(`[${this.config.stationId}] Authorize (offline/cached): ${status}`);
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [statusField]: cached };
      }
      // Check AllowOfflineTxForUnknownId
      const allowUnknown = this.getConfigValue('AllowOfflineTxForUnknownId') === 'true';
      if (allowUnknown) {
        console.log(
          `[${this.config.stationId}] Authorize (offline/unknown): Accepted (AllowOfflineTxForUnknownId)`,
        );
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [statusField]: { status: 'Accepted' } };
      }
      console.log(`[${this.config.stationId}] Authorize (offline/unknown): Unknown`);
      const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
      return { [statusField]: { status: 'Unknown' } };
    }

    const payload = this.is16 ? { idTag: idToken } : { idToken: { idToken, type: tokenType } };
    let response: Record<string, unknown>;
    try {
      response = await this.client.sendCall('Authorize', payload);
    } catch (err) {
      // Connection error during send: fall back to local auth / cache
      const localEntry = this.localAuthEntries.get(idToken);
      if (localEntry != null) {
        const status = (localEntry['authStatus'] as string | undefined) ?? 'Accepted';
        console.log(`[${this.config.stationId}] Authorize (connection error/local): ${status}`);
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [statusField]: { status } };
      }
      const cached = this.cachedIdTokenInfo(idToken);
      if (cached != null) {
        const status = cached['status'] as string;
        console.log(`[${this.config.stationId}] Authorize (connection error/cached): ${status}`);
        const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
        return { [statusField]: cached };
      }
      throw err;
    }

    const statusField = this.is16 ? 'idTagInfo' : 'idTokenInfo';
    const idTokenInfo = response[statusField] as Record<string, unknown> | undefined;
    console.log(
      `[${this.config.stationId}] Authorize: ${idTokenInfo != null ? (idTokenInfo['status'] as string) : 'unknown'}`,
    );

    // Feature 2: Cache the auth result
    if (idTokenInfo != null) {
      this.cacheIdTokenInfo(idToken, idTokenInfo);

      // Feature 3: Store group token mapping if present
      // OCPP 2.1 uses groupIdToken, OCPP 1.6 uses parentIdTag
      if (this.is16) {
        const parentIdTag = idTokenInfo['parentIdTag'] as string | undefined;
        if (parentIdTag != null) {
          this.tokenGroupMap.set(idToken, { idToken: parentIdTag, type: 'ISO14443' });
        }
      } else {
        const groupIdToken = idTokenInfo['groupIdToken'] as Record<string, unknown> | undefined;
        if (groupIdToken != null) {
          this.tokenGroupMap.set(idToken, groupIdToken);
        }
      }
    }

    // OCPP 2.1: Process driver tariff from AuthorizeResponse
    if (!this.is16) {
      const tariff = response['tariff'] as Record<string, unknown> | undefined;
      if (tariff != null) {
        const tariffId = tariff['tariffId'] as string;
        // Store the driver tariff (keyed by a placeholder EVSE; actual EVSE resolved in beginTransaction)
        this.driverTariffs.set(0, { tariffId, tariff });
        console.log(`[${this.config.stationId}] Received driver tariff: ${tariffId}`);

        // If TariffCostCtrlr is not enabled, report TariffCostCtrlr Problem via NotifyEvent
        const tariffEnabled = this.getConfigValue('TariffCostCtrlr.Enabled') ?? 'true';
        if (tariffEnabled !== 'true') {
          void this.sendNotifyEvent([
            {
              eventId: Date.now(),
              timestamp: new Date().toISOString(),
              trigger: 'Delta',
              actualValue: 'true',
              component: { name: 'TariffCostCtrlr' },
              variable: { name: 'Problem' },
            },
          ]).catch(() => {});
          // Deauthorize if configured to do so (I08.FR.31)
          const deauthorize =
            this.getConfigValue('TariffCostCtrlr.DeauthorizeOnProblem') ?? 'false';
          if (deauthorize === 'true' && idTokenInfo != null) {
            idTokenInfo['status'] = 'Invalid';
          }
        }
      }
    }

    return response;
  }

  /**
   * C10.FR.13: an idTokenInfo whose cacheExpiryDateTime has passed is not kept in the
   * Authorization Cache (prepaid tokens, C17, get cacheExpiryDateTime = now).
   */
  private cacheEntryExpired(info: Record<string, unknown>): boolean {
    if (this.is16) return false;
    const expiry = info['cacheExpiryDateTime'];
    if (typeof expiry !== 'string') return false;
    const expiresAt = Date.parse(expiry);
    return Number.isFinite(expiresAt) && expiresAt <= Date.now();
  }

  /** C10.FR.04/05/13: store an idTokenInfo, or remove the entry when it is already expired. */
  private cacheIdTokenInfo(idToken: string, info: Record<string, unknown>): void {
    if (this.cacheEntryExpired(info)) {
      this.authCache.delete(idToken);
      return;
    }
    this.authCache.set(idToken, info);
  }

  /** The cached idTokenInfo, removing it once its cacheExpiryDateTime has passed (C10.FR.13). */
  private cachedIdTokenInfo(idToken: string): Record<string, unknown> | undefined {
    const cached = this.authCache.get(idToken);
    if (cached == null) return undefined;
    if (this.cacheEntryExpired(cached)) {
      this.authCache.delete(idToken);
      return undefined;
    }
    return cached;
  }

  clearAuthCache(): void {
    this.authCache.clear();
    this.tokenGroupMap.clear();
  }

  /** Add a token to the auth cache. For testing. */
  addToAuthCache(
    idToken: string,
    status: string = 'Accepted',
    groupIdToken?: { idToken: string; type: string },
  ): void {
    const entry: Record<string, unknown> = { status };
    if (groupIdToken != null) {
      entry['groupIdToken'] = groupIdToken;
      this.tokenGroupMap.set(idToken, groupIdToken);
    }
    this.authCache.set(idToken, entry);
  }

  /**
   * Store a SendLocalList entry. The OCPP entry carries the status and group in
   * idTokenInfo (2.1) or idTagInfo (1.6); the local list readers use the flat
   * `authStatus` / `groupIdToken` fields, so both are kept, and the group is
   * registered for GroupId stop authorization (C09, E08.FR.02).
   */
  private storeLocalAuthEntry(idToken: string, entry: Record<string, unknown>): void {
    const info = (this.is16 ? entry['idTagInfo'] : entry['idTokenInfo']) as
      | Record<string, unknown>
      | undefined;
    const status = (info?.['status'] as string | undefined) ?? 'Accepted';
    let groupIdToken: Record<string, unknown> | undefined;
    if (this.is16) {
      const parentIdTag = info?.['parentIdTag'] as string | undefined;
      if (parentIdTag != null) groupIdToken = { idToken: parentIdTag, type: 'ISO14443' };
    } else {
      groupIdToken = info?.['groupIdToken'] as Record<string, unknown> | undefined;
    }
    const tokenType = this.is16
      ? undefined
      : ((entry['idToken'] as Record<string, unknown> | undefined)?.['type'] as string | undefined);
    const stored: Record<string, unknown> = { ...entry, authStatus: status };
    if (groupIdToken != null) {
      stored['groupIdToken'] = groupIdToken;
      this.tokenGroupMap.set(idToken, groupIdToken);
    }
    if (tokenType != null) stored['tokenType'] = tokenType;
    this.localAuthEntries.set(idToken, stored);
  }

  /** SmartChargingCtrlr.RateUnit: the charging rate units the station accepts (K01). */
  private supportedRateUnits(): string[] {
    return (this.getConfigValue('SmartChargingCtrlr.RateUnit') ?? 'A,W')
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u !== '');
  }

  /**
   * K01 SetChargingProfile checks the simulator applies before the generic
   * ones: unknown EVSE, unsupported rate unit, additional purposes it does not
   * support (UnsupportedPurpose), and schedule features it does not support
   * (InvalidSchedule: useLocalTime, randomizedDelay, limitAtSoC, evseSleep;
   * SmartChargingCtrlr.SupportsFeature[...] false).
   */
  private validateChargingProfile21(
    profile: Record<string, unknown>,
    evseId: number,
  ): Record<string, unknown> | null {
    if (evseId !== 0 && !this.config.evses.some((e) => e.evseId === evseId)) {
      return { status: 'Rejected', statusInfo: { reasonCode: 'UnknownEVSE' } };
    }
    const purpose = profile['chargingProfilePurpose'] as string | undefined;
    const additional = ['PriorityCharging', 'LocalGeneration'];
    const supportedAdditional = (
      this.getConfigValue('SmartChargingCtrlr.SupportedAdditionalPurposes') ?? ''
    )
      .split(',')
      .map((v) => v.trim());
    if (purpose != null && additional.includes(purpose) && !supportedAdditional.includes(purpose)) {
      return { status: 'Rejected', statusInfo: { reasonCode: 'UnsupportedPurpose' } };
    }
    const feature = (name: string): boolean =>
      this.getConfigValue(`SmartChargingCtrlr.SupportsFeature#${name}`) === 'true';
    const rawSchedules = profile['chargingSchedule'];
    const schedules = (
      Array.isArray(rawSchedules) ? rawSchedules : rawSchedules != null ? [rawSchedules] : []
    ) as Array<Record<string, unknown>>;
    for (const schedule of schedules) {
      const unit = schedule['chargingRateUnit'] as string | undefined;
      if (unit != null && !this.supportedRateUnits().includes(unit)) {
        return { status: 'Rejected', statusInfo: { reasonCode: 'UnsupportedRateUnit' } };
      }
      const periods = (schedule['chargingSchedulePeriod'] ?? []) as Array<Record<string, unknown>>;
      const unsupported =
        (schedule['useLocalTime'] === true && !feature('UseLocalTime')) ||
        (schedule['randomizedDelay'] != null && !feature('RandomizedDelay')) ||
        (schedule['limitAtSoC'] != null && !feature('LimitAtSoC')) ||
        (periods.some((p) => p['evseSleep'] === true) && !feature('EvseSleep'));
      if (unsupported) {
        return { status: 'Rejected', statusInfo: { reasonCode: 'InvalidSchedule' } };
      }
    }
    return null;
  }

  /**
   * K01: profiles with invalidAfterOfflineDuration become invalid for good
   * when the station was offline longer than their maxOfflineDuration.
   */
  private invalidateProfilesAfterOffline(offlineMs: number): void {
    for (const [id, profile] of Array.from(this.chargingProfilesCache)) {
      const maxOffline = profile['maxOfflineDuration'] as number | undefined;
      if (maxOffline == null || profile['invalidAfterOfflineDuration'] !== true) continue;
      if (offlineMs > maxOffline * 1000 && profile['_invalidated'] !== true) {
        this.chargingProfilesCache.set(id, { ...profile, _invalidated: true });
      }
    }
  }

  /** tariffId of the default tariff for an EVSE: its own, else the station-wide one (I07). */
  private defaultTariffIdFor(evseId: number): string | null {
    let stationWide: string | null = null;
    for (const [tariffId, entry] of this.defaultTariffs) {
      if (entry.evseId === evseId) return tariffId;
      if (entry.evseId === 0) stationWide = tariffId;
    }
    return stationWide;
  }

  /** Add a token to the local auth list. For testing. */
  addToLocalAuthList(
    idToken: string,
    status: string = 'Accepted',
    groupIdToken?: { idToken: string; type: string },
  ): void {
    const entry: Record<string, unknown> = { authStatus: status };
    if (groupIdToken != null) {
      entry['groupIdToken'] = groupIdToken;
      this.tokenGroupMap.set(idToken, groupIdToken);
    }
    this.localAuthEntries.set(idToken, entry);
  }

  async sendTransactionEvent(
    evseId: number,
    eventType: 'Started' | 'Updated' | 'Ended',
    opts: {
      triggerReason: string;
      transactionId: string;
      chargingState?: string;
      stoppedReason?: string;
      idToken?: string;
      tokenType?: string;
      seqNo?: number;
      meterValue?: Array<Record<string, unknown>>;
      transactionLimit?: { maxEnergy?: number; maxTime?: number; maxCost?: number };
      costDetails?: Record<string, unknown>;
      remoteStartId?: number;
    },
  ): Promise<Record<string, unknown>> {
    const seqNo = opts.seqNo ?? this.evseSeqNo.get(evseId) ?? 0;
    const transactionInfo: Record<string, unknown> = {
      transactionId: opts.transactionId,
    };
    // Include remoteStartId from opts or from the EVSE context
    const rsId = opts.remoteStartId ?? this.evseContexts.get(evseId)?.remoteStartId;
    if (rsId != null) {
      transactionInfo['remoteStartId'] = rsId;
    }
    if (opts.chargingState != null) {
      transactionInfo['chargingState'] = opts.chargingState;
    }
    // Include tariffId from driver tariff or default tariff
    if (!this.is16) {
      const driverTariff = this.driverTariffs.get(evseId) ?? this.driverTariffs.get(0);
      const defaultTariffId = this.defaultTariffIdFor(evseId);
      if (driverTariff != null) {
        transactionInfo['tariffId'] = driverTariff.tariffId;
      } else if (defaultTariffId != null) {
        // I07: the default tariff of the EVSE (or the station) applies
        transactionInfo['tariffId'] = defaultTariffId;
      }
    }
    if (opts.stoppedReason != null) {
      transactionInfo['stoppedReason'] = opts.stoppedReason;
    }
    if (opts.transactionLimit != null) {
      transactionInfo['transactionLimit'] = opts.transactionLimit;
    }

    const payload: Record<string, unknown> = {
      eventType,
      timestamp: new Date().toISOString(),
      triggerReason: opts.triggerReason,
      seqNo,
      transactionInfo,
      evse: { id: evseId, connectorId: this.getConnectorId(evseId) },
    };

    if (opts.idToken != null) {
      payload['idToken'] = {
        idToken: opts.idToken,
        type: opts.tokenType ?? 'ISO14443',
      };
    }

    if (opts.meterValue != null) {
      payload['meterValue'] = opts.meterValue;
    }

    if (opts.costDetails != null) {
      payload['costDetails'] = opts.costDetails;
    }

    // Set offline flag when not connected
    if (!this.client.isConnected) {
      payload['offline'] = true;
      this.queueOfflineMessage('TransactionEvent', payload);
      return {};
    }

    // Transaction messages are delivered in order: while older ones wait in the
    // queue, a new one joins the queue instead of overtaking them. The reconnect
    // sequence (or the replay already running) delivers it after the connector
    // statuses.
    if (this.hasQueuedTransactionMessages()) {
      this.queueOfflineMessage('TransactionEvent', payload);
      return {};
    }

    let response: Record<string, unknown>;
    try {
      response = await this.client.sendCall('TransactionEvent', payload);
    } catch (err) {
      // Connection lost while the message was in flight: keep it for delivery
      // after reconnect (E11.FR.01). Every message still queued when the
      // station goes offline is set offline (E11.FR.07). isConnected is a
      // getter that changed during the await.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.client.isConnected) {
        payload['offline'] = true;
        this.queueOfflineMessage('TransactionEvent', payload);
        return {};
      }
      throw err;
    }

    // C10.FR.05: the idTokenInfo of the response updates the Authorization Cache
    if (!this.is16 && opts.idToken != null) {
      const idTokenInfo = response['idTokenInfo'] as Record<string, unknown> | undefined;
      if (idTokenInfo != null) this.cacheIdTokenInfo(opts.idToken, idTokenInfo);
      // E05: a rejected idToken on an Updated event (beginTransaction handles Started)
      if (eventType === 'Updated' && this.isRejectedIdTokenInfo(response)) {
        setTimeout(() => {
          void this.handleRejectedTransactionIdToken(evseId).catch(() => {});
        }, 0);
      }
    }

    // OCPP 2.1: process transactionLimit and totalCost from response.
    // Deferred so the current call chain completes first (e.g., startCharging
    // finishes Started + ChargingStateChanged before LimitSet fires).
    if (!this.is16 && eventType !== 'Ended') {
      const hasTxLimit = response['transactionLimit'] != null;
      const hasTotalCost = response['totalCost'] != null;
      if (hasTxLimit || hasTotalCost) {
        const txIdCopy = opts.transactionId;
        const responseCopy = { ...response };
        setTimeout(() => {
          void this.processTransactionEventResponse(evseId, txIdCopy, responseCopy).catch(() => {});
        }, 0);
      }
    }

    return response;
  }

  /**
   * Process TransactionEventResponse fields: transactionLimit and totalCost.
   * When a new limit is received, sends a TransactionEvent Updated with triggerReason LimitSet.
   */
  private async processTransactionEventResponse(
    evseId: number,
    transactionId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    // Store totalCost from CSMS
    const totalCost = response['totalCost'] as number | undefined;
    if (totalCost != null) {
      this.evseTotalCost.set(evseId, totalCost);
      // Immediately check cost limit (the meter loop check may have already run this tick)
      if (await this.checkCentralCostLimit(evseId, transactionId)) return;
    }

    // Process transactionLimit from CSMS
    const limit = response['transactionLimit'] as Record<string, unknown> | undefined;
    if (limit == null) return;

    const newLimit: { maxEnergy?: number; maxTime?: number; maxCost?: number } = {};
    if (limit['maxEnergy'] != null) newLimit.maxEnergy = limit['maxEnergy'] as number;
    if (limit['maxTime'] != null) newLimit.maxTime = limit['maxTime'] as number;
    if (limit['maxCost'] != null) newLimit.maxCost = limit['maxCost'] as number;

    // Merge with existing limits (CSMS update replaces previous values for same fields)
    const existing = this.evseTransactionLimits.get(evseId) ?? {};
    const merged = { ...existing, ...newLimit };
    this.evseTransactionLimits.set(evseId, merged);

    // Reset limit-reached flag when limits change
    this.evseLimitReached.set(evseId, false);

    // Send TransactionEvent Updated with triggerReason LimitSet
    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason: 'LimitSet',
      transactionId,
      chargingState: this.evseChargingState.get(evseId) ?? 'Charging',
      seqNo,
      transactionLimit: merged,
    });

    // Immediately check if limits are already exceeded
    const gen = this.meterGens.get(evseId);
    if (gen != null && !(this.evseLimitReached.get(evseId) ?? false)) {
      await this.checkTransactionLimits(evseId, transactionId, gen);
    }
  }

  async sendFirmwareStatusNotification(status: string, requestId?: number): Promise<void> {
    if (this.is16) {
      await this.client.sendCall('FirmwareStatusNotification', { status });
    } else {
      await this.client.sendCall('FirmwareStatusNotification', {
        status,
        requestId: requestId ?? 0,
      });
    }
  }

  async sendLogStatusNotification(status: string, requestId?: number): Promise<void> {
    if (this.is16) {
      // OCPP 1.6 Security Whitepaper: requestId is optional and omitted when idle.
      const payload: Record<string, unknown> = { status };
      if (requestId != null) payload['requestId'] = requestId;
      await this.client.sendCall('LogStatusNotification', payload);
    } else {
      await this.client.sendCall('LogStatusNotification', {
        status,
        requestId: requestId ?? 0,
      });
    }
  }

  async sendSecurityEventNotification(
    type: string,
    timestamp?: string,
    techInfo?: string,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      type,
      timestamp: timestamp ?? new Date().toISOString(),
    };
    if (techInfo != null) payload['techInfo'] = techInfo;
    return this.client.sendCall('SecurityEventNotification', payload);
  }

  async sendNotifyEvent(
    eventData: Array<Record<string, unknown>>,
    seqNo: number = 0,
    tbc: boolean = false,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo,
      tbc,
      eventData,
    });
  }

  private parseConfigKey(key: string): {
    componentName: string;
    variableName: string;
    instance: string | undefined;
    evseId: number | undefined;
    connectorId: number | undefined;
  } {
    const dotIdx = key.indexOf('.');
    const afterDot = dotIdx >= 0 ? key.substring(dotIdx + 1) : key;
    const hashIdx = afterDot.indexOf('#');
    let componentName = dotIdx >= 0 ? key.substring(0, dotIdx) : key;
    const variableName = hashIdx >= 0 ? afterDot.substring(0, hashIdx) : afterDot;
    const instance = hashIdx >= 0 ? afterDot.substring(hashIdx + 1) : undefined;

    let evseId: number | undefined;
    let connectorId: number | undefined;
    const bracketIdx = componentName.indexOf('[');
    if (bracketIdx >= 0 && componentName.endsWith(']')) {
      const scope = componentName.substring(bracketIdx + 1, componentName.length - 1);
      componentName = componentName.substring(0, bracketIdx);
      const parts = scope.split(',').map((p) => Number.parseInt(p, 10));
      const first = parts[0];
      const second = parts[1];
      if (first != null && Number.isFinite(first)) evseId = first;
      if (second != null && Number.isFinite(second)) connectorId = second;
    }

    return { componentName, variableName, instance, evseId, connectorId };
  }

  private countMatchingVariables(filters?: {
    componentCriteria?: string[] | undefined;
    componentVariable?:
      | Array<{
          component: { name: string; evse?: { id: number }; instance?: string };
          variable: { name: string; instance?: string };
        }>
      | undefined;
  }): number {
    let count = 0;
    for (const [key, entry] of this.configVariables) {
      const { componentName, variableName, instance } = this.parseConfigKey(key);

      if (filters?.componentCriteria != null && filters.componentCriteria.length > 0) {
        const criteria = filters.componentCriteria;
        let matches = false;
        if (criteria.includes('Enabled') && variableName === 'Enabled' && entry.value === 'true')
          matches = true;
        if (criteria.includes('Active') && variableName === 'Enabled' && entry.value === 'true')
          matches = true;
        if (criteria.includes('Available') && variableName === 'AvailabilityState') matches = true;
        if (
          criteria.includes('Problem') &&
          (variableName === 'Problem' ||
            variableName === 'Tripped' ||
            variableName === 'Overload' ||
            variableName === 'Fallback')
        )
          matches = true;
        if (!matches) continue;
      }

      if (filters?.componentVariable != null && filters.componentVariable.length > 0) {
        let matches = false;
        for (const cv of filters.componentVariable) {
          const compMatches = cv.component.name === componentName;
          const varMatches = cv.variable.name === variableName;
          const instanceMatches = cv.variable.instance == null || cv.variable.instance === instance;
          if (compMatches && varMatches && instanceMatches) {
            matches = true;
            break;
          }
        }
        if (!matches) continue;
      }

      count++;
    }
    return count;
  }

  async sendNotifyReport(
    requestId: number,
    filters?: {
      componentCriteria?: string[] | undefined;
      componentVariable?:
        | Array<{
            component: { name: string; evse?: { id: number }; instance?: string };
            variable: { name: string; instance?: string };
          }>
        | undefined;
    },
  ): Promise<void> {
    const reportData: Array<Record<string, unknown>> = [];

    for (const [key, entry] of this.configVariables) {
      const { componentName, variableName, instance, evseId, connectorId } =
        this.parseConfigKey(key);

      // Apply componentCriteria filter
      if (filters?.componentCriteria != null && filters.componentCriteria.length > 0) {
        const criteria = filters.componentCriteria;
        let matches = false;
        if (criteria.includes('Enabled') && variableName === 'Enabled' && entry.value === 'true')
          matches = true;
        if (criteria.includes('Active') && variableName === 'Enabled' && entry.value === 'true')
          matches = true;
        if (criteria.includes('Available') && variableName === 'AvailabilityState') matches = true;
        if (
          criteria.includes('Problem') &&
          (variableName === 'Problem' ||
            variableName === 'Tripped' ||
            variableName === 'Overload' ||
            variableName === 'Fallback')
        )
          matches = true;
        if (!matches) continue;
      }

      // Apply componentVariable filter
      if (filters?.componentVariable != null && filters.componentVariable.length > 0) {
        let matches = false;
        for (const cv of filters.componentVariable) {
          const compMatches = cv.component.name === componentName;
          const varMatches = cv.variable.name === variableName;
          // If instance filter is specified, must match. If not specified, match all.
          const instanceMatches = cv.variable.instance == null || cv.variable.instance === instance;
          if (compMatches && varMatches && instanceMatches) {
            matches = true;
            break;
          }
        }
        if (!matches) continue;
      }

      const component: Record<string, unknown> = { name: componentName };
      if (evseId != null) {
        const evse: Record<string, unknown> = { id: evseId };
        if (connectorId != null) evse['connectorId'] = connectorId;
        component['evse'] = evse;
      }
      const variable: Record<string, unknown> = { name: variableName };
      if (instance != null) variable['instance'] = instance;

      // B07: a report leaves out the value of a WriteOnly variable
      const writeOnly = WRITE_ONLY_VARIABLES.has(`${componentName}.${variableName}`);
      const attribute: Record<string, unknown> = {
        type: 'Actual',
        mutability: writeOnly ? 'WriteOnly' : entry.readonly ? 'ReadOnly' : 'ReadWrite',
      };
      if (!writeOnly) attribute['value'] = entry.value;
      reportData.push({
        component,
        variable,
        variableAttribute: [attribute],
        // EVSE.Power must carry its rated power as maxLimit (2.1 device model).
        variableCharacteristics:
          componentName === 'EVSE' && variableName === 'Power'
            ? {
                unit: 'W',
                dataType: 'decimal',
                maxLimit: Number(entry.value),
                supportsMonitoring: false,
              }
            : {
                dataType: 'string',
                supportsMonitoring: false,
              },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    if (this.destroyed) return;
    try {
      await this.client.sendCall('NotifyReport', {
        requestId,
        seqNo: 0,
        tbc: false,
        generatedAt: new Date().toISOString(),
        reportData,
      });
    } catch (err) {
      logger.warn({ err, stationId: this.config.stationId, requestId }, 'NotifyReport failed');
    }
  }

  async sendDataTransfer(
    vendorId: string,
    messageId?: string,
    data?: string,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { vendorId };
    if (messageId != null) payload['messageId'] = messageId;
    if (data != null) payload['data'] = data;
    return this.client.sendCall('DataTransfer', payload);
  }

  async sendNotifyMonitoringReport(
    requestId: number,
    monitor: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyMonitoringReport', {
      requestId,
      seqNo: 0,
      tbc: false,
      generatedAt: new Date().toISOString(),
      monitor,
    });
  }

  async sendNotifyChargingLimit(
    chargingLimit: Record<string, unknown>,
    chargingSchedule?: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { chargingLimit };
    if (chargingSchedule != null) payload['chargingSchedule'] = chargingSchedule;
    return this.client.sendCall('NotifyChargingLimit', payload);
  }

  async sendNotifyEVChargingNeeds(
    evseId: number,
    chargingNeeds: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyEVChargingNeeds', {
      evseId,
      chargingNeeds,
    });
  }

  async sendClearedChargingLimit(
    chargingLimitSource: string,
    evseId?: number,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { chargingLimitSource };
    if (evseId != null) payload['evseId'] = evseId;
    return this.client.sendCall('ClearedChargingLimit', payload);
  }

  async sendReservationStatusUpdate(
    reservationId: number,
    reservationUpdateStatus: string,
  ): Promise<Record<string, unknown>> {
    // ReservationStatusUpdate is OCPP 2.1 only. On 1.6 the CSMS replies with
    // NotImplemented, which the simulator otherwise logs as an error per
    // call attempt. 1.6 stations communicate reservation expiry implicitly
    // via StatusNotification(Available) when the timer fires.
    if (this.is16) {
      return { status: 'Accepted' };
    }
    return this.client.sendCall('ReservationStatusUpdate', {
      reservationId,
      reservationUpdateStatus,
    });
  }

  async sendNotifyDisplayMessages(
    requestId: number,
    messageInfo: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyDisplayMessages', {
      requestId,
      messageInfo,
      tbc: false,
    });
  }

  async sendNotifyCustomerInformation(
    requestId: number,
    data: string,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyCustomerInformation', {
      requestId,
      data,
      seqNo: 0,
      tbc: false,
      generatedAt: new Date().toISOString(),
    });
  }

  async sendSignCertificate(
    csr: string,
    certificateType: string = 'ChargingStationCertificate',
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('SignCertificate', { csr, certificateType });
  }

  async sendGetCertificateStatus(
    ocspRequestData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('GetCertificateStatus', { ocspRequestData });
  }

  async sendGetTransactionStatus(transactionId?: string): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {};
    if (transactionId != null) payload['transactionId'] = transactionId;
    return this.client.sendCall('GetTransactionStatus', payload);
  }

  async sendReportChargingProfiles(
    requestId: number,
    chargingProfile: Array<Record<string, unknown>>,
    evseId: number,
    chargingLimitSource: string = 'CSO',
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('ReportChargingProfiles', {
      requestId,
      chargingLimitSource,
      chargingProfile,
      evseId,
      tbc: false,
    });
  }

  async sendNotifyEVChargingSchedule(
    timeBase: string,
    evseId: number,
    chargingSchedule: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyEVChargingSchedule', {
      timeBase,
      evseId,
      chargingSchedule,
    });
  }

  async sendNotifySettlement(
    settlementData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifySettlement', settlementData);
  }

  async sendNotifyPriorityCharging(
    transactionId: string,
    activated: boolean,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyPriorityCharging', {
      transactionId,
      activated,
    });
  }

  async sendNotifyAllowedEnergyTransfer(
    allowedEnergyTransfer: string[],
    transactionId: string = 'unknown',
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyAllowedEnergyTransfer', {
      transactionId,
      allowedEnergyTransfer,
    });
  }

  async sendGet15118EVCertificate(
    iso15118SchemaVersion: string,
    action: string,
    exiRequest: string,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('Get15118EVCertificate', {
      iso15118SchemaVersion,
      action,
      exiRequest,
    });
  }

  async sendGetCertificateChainStatus(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('GetCertificateChainStatus', payload);
  }

  async sendPublishFirmwareStatusNotification(
    status: string,
    requestId?: number,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('PublishFirmwareStatusNotification', {
      status,
      requestId: requestId ?? 0,
    });
  }

  /** WebPaymentsCtrlr.URLParameters: the query parameters the EV driver can enter. */
  private webPaymentUrlParameters(): Set<string> {
    const value = this.getConfigValue('WebPaymentsCtrlr.URLParameters') ?? '';
    return new Set(
      value
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p !== ''),
    );
  }

  /** WebPaymentsCtrlr value ranges (2.1 Part 2, Referenced Components and Variables). */
  private isValidWebPaymentsValue(varName: string, value: string): boolean {
    const n = Number(value);
    switch (varName) {
      case 'Enabled':
        return value === 'true' || value === 'false';
      case 'TOTPVersion':
        return value === TOTP_VERSION_V1;
      case 'ValidityTime':
        return Number.isInteger(n) && n >= 6 && n <= 3600;
      case 'Length':
        return Number.isInteger(n) && n >= 6;
      case 'SharedSecret':
        return value.length >= 8;
      default:
        return true;
    }
  }

  /**
   * Manual action (C25.FR.03): the EV driver enters limits for a QR code payment on an EVSE
   * before the QR code is shown. Only parameters listed in WebPaymentsCtrlr.URLParameters
   * can be entered. The limits go into the QR code URL and apply to the next transaction
   * on the EVSE (C25.FR.04-06).
   */
  enterWebPaymentLimits(evseId: number, limits: WebPaymentLimits): void {
    if (this.is16) throw new Error('Web payments (C25) need OCPP 2.1');
    const supported = this.webPaymentUrlParameters();
    for (const [field, param] of WEB_PAYMENT_URL_PARAMETERS) {
      if (limits[field] != null && !supported.has(param)) {
        throw new Error(`WebPaymentsCtrlr.URLParameters does not contain ${param}`);
      }
    }
    this.evseWebPaymentLimits.set(evseId, { ...limits });
  }

  /**
   * C25.FR.01: the URL of the dynamic QR code the station shows for an EVSE, or null when
   * WebPaymentsCtrlr is not enabled or not configured. The URL template placeholders are
   * replaced per C25.FR.50-53 with a TOTP v1 of the current interval, and the limits the
   * EV driver entered are added as query parameters (C25.FR.04-06).
   */
  webPaymentQrUrl(evseId: number, atMs: number = Date.now()): string | null {
    if (this.is16 || this.getConfigValue('WebPaymentsCtrlr.Enabled') !== 'true') return null;
    const template = this.getConfigValue('WebPaymentsCtrlr.URLTemplate') ?? '';
    const version = this.getConfigValue('WebPaymentsCtrlr.TOTPVersion') ?? '';
    const sharedSecret = this.getConfigValue('WebPaymentsCtrlr.SharedSecret') ?? '';
    const validitySeconds = Number(this.getConfigValue('WebPaymentsCtrlr.ValidityTime'));
    const length = Number(this.getConfigValue('WebPaymentsCtrlr.Length'));
    if (
      template === '' ||
      !this.isValidWebPaymentsValue('TOTPVersion', version) ||
      !this.isValidWebPaymentsValue('SharedSecret', sharedSecret) ||
      !this.isValidWebPaymentsValue('ValidityTime', String(validitySeconds)) ||
      !this.isValidWebPaymentsValue('Length', String(length))
    ) {
      return null;
    }
    const totp = totpV1({ sharedSecret, validitySeconds, length }, atMs);
    const identity = this.getConfigValue('SecurityCtrlr.Identity') ?? this.config.stationId;
    const roamingEvseId = this.getConfigValue('WebPaymentsCtrlr.RoamingEvseId') ?? '';
    let url = template
      .replaceAll('{chargingstationid}', encodeURIComponent(identity))
      .replaceAll('{roamingevseid}', encodeURIComponent(roamingEvseId))
      .replaceAll('{evse}', String(evseId))
      .replaceAll('{totp}', totp)
      .replaceAll('{version}', version);
    const limits = this.evseWebPaymentLimits.get(evseId);
    if (limits != null) {
      const query = WEB_PAYMENT_URL_PARAMETERS.flatMap(([field, param]) => {
        const value = limits[field];
        return value != null ? [`${param}=${encodeURIComponent(String(value))}`] : [];
      });
      if (query.length > 0) url += (url.includes('?') ? '&' : '?') + query.join('&');
    }
    return url;
  }

  async sendNotifyPeriodicEventStream(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyPeriodicEventStream', payload);
  }

  async sendNotifyDERAlarm(alarmInfo: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyDERAlarm', alarmInfo);
  }

  async sendNotifyDERStartStop(info: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.sendCall('NotifyDERStartStop', info);
  }

  async sendReportDERControl(
    controlData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.sendCall('ReportDERControl', controlData);
  }

  async sendBatterySwap(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.sendCall('BatterySwap', payload);
  }

  async sendPullDynamicScheduleUpdate(chargingProfileId: number): Promise<Record<string, unknown>> {
    return this.client.sendCall('PullDynamicScheduleUpdate', { chargingProfileId });
  }

  async sendVatNumberValidation(
    vatNumber: string,
    evseId?: number,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { vatNumber };
    if (evseId != null) payload['evseId'] = evseId;
    return this.client.sendCall('VatNumberValidation', payload);
  }

  // ---------------------------------------------------------------------------
  // Group 5: OCPP 1.6 specific station-initiated messages
  // ---------------------------------------------------------------------------

  async sendStartTransaction(
    connectorId: number,
    idTag: string,
    reservationId?: number,
  ): Promise<Record<string, unknown>> {
    const gen = this.meterGens.get(connectorId);
    const payload: Record<string, unknown> = {
      connectorId,
      idTag,
      meterStart: gen?.energyWh ?? 0,
      timestamp: new Date().toISOString(),
    };
    if (reservationId != null) payload['reservationId'] = reservationId;
    return this.client.sendCall('StartTransaction', payload);
  }

  async sendStopTransaction(
    transactionId: number,
    meterStop: number,
    reason: string = 'Local',
    idTag?: string,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      transactionId,
      meterStop,
      timestamp: new Date().toISOString(),
      reason,
    };
    if (idTag != null) payload['idTag'] = idTag;
    return this.client.sendCall('StopTransaction', payload);
  }

  async sendDiagnosticsStatusNotification(status: string): Promise<Record<string, unknown>> {
    return this.client.sendCall('DiagnosticsStatusNotification', { status });
  }

  // ---------------------------------------------------------------------------
  // Group 6: Clock-aligned (public, called by ClockAlignedScheduler)
  // ---------------------------------------------------------------------------

  /** Start internal clock-aligned meter value timer. */
  startClockAlignedTimer(): void {
    this.stopClockAlignedTimer();
    const intervalSec = this.getAlignedIntervalSeconds();
    console.log(`[${this.config.stationId}] Clock-aligned timer: interval=${String(intervalSec)}s`);
    if (intervalSec <= 0) return;
    this.clockAlignedTimer = setInterval(() => {
      console.log(`[${this.config.stationId}] Clock-aligned timer FIRED`);
      void this.sendClockAlignedMeterValues().catch(() => {});
    }, intervalSec * 1000);
  }

  /** Stop internal clock-aligned meter value timer. */
  stopClockAlignedTimer(): void {
    if (this.clockAlignedTimer != null) {
      clearInterval(this.clockAlignedTimer);
      this.clockAlignedTimer = null;
    }
  }

  sendClockAlignedMeterValues(): Promise<void> {
    const interval = this.getAlignedIntervalSeconds();
    if (interval <= 0) {
      console.log(
        `[${this.config.stationId}] Clock-aligned: interval=${String(interval)}, skipping`,
      );
      return Promise.resolve();
    }
    if (!this.client.isConnected) {
      console.log(`[${this.config.stationId}] Clock-aligned: not connected, skipping`);
      return Promise.resolve();
    }
    // Until its BootNotification is Accepted a station sends nothing but BootNotification.
    if (this.bootStatus !== 'Accepted') {
      return Promise.resolve();
    }

    const measurands = this.getAlignedMeasurands();
    if (measurands.length === 0) {
      console.log(`[${this.config.stationId}] Clock-aligned: no measurands, skipping`);
      return Promise.resolve();
    }

    // Use the first EVSE's generator for station-level readings
    const firstEvse = this.config.evses[0];
    if (firstEvse == null) return Promise.resolve();
    const gen = this.meterGens.get(firstEvse.evseId);
    if (gen == null) return Promise.resolve();

    // Without a transaction the reading is ambient (no power). During a
    // transaction it reports the EVSE's real state, which the periodic
    // readings keep current: the power a charging EV draws, 0 while it is
    // suspended. An idle tick here reported 0 W with chargingState Charging
    // (finding JB-1), and a charging tick would add energy between samples.
    if (this.getActiveTransactionSync(firstEvse.evseId) == null) {
      gen.tick(true, this.evsePowerLimits.get(firstEvse.evseId) ?? null);
    }

    const sampledValues = gen
      .generate(measurands, this.is16)
      .map((sv) => ({ ...sv, context: 'Sample.Clock' }));
    if (sampledValues.length === 0) return Promise.resolve();

    // OCPP 2.1 during transaction: send TransactionEvent Updated with MeterValueClock
    if (!this.is16) {
      const txId = this.getActiveTransactionSync(firstEvse.evseId);
      if (txId != null) {
        const seqNo = (this.evseSeqNo.get(firstEvse.evseId) ?? 0) + 1;
        this.evseSeqNo.set(firstEvse.evseId, seqNo);
        this.sendTransactionEvent(firstEvse.evseId, 'Updated', {
          triggerReason: 'MeterValueClock',
          transactionId: txId,
          chargingState: this.evseChargingState.get(firstEvse.evseId) ?? 'Charging',
          seqNo,
          meterValue: [{ timestamp: new Date().toISOString(), sampledValue: sampledValues }],
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            !msg.includes('not open') &&
            !msg.includes('timed out') &&
            !msg.includes('Not connected') &&
            !msg.includes('disconnected')
          ) {
            console.warn(`[clock-aligned] ${this.config.stationId}: ${msg}`);
          }
        });
        return Promise.resolve();
      }
    }

    const payload = this.is16
      ? {
          connectorId: 0,
          meterValue: [{ timestamp: new Date().toISOString(), sampledValue: sampledValues }],
        }
      : {
          evseId: 0,
          meterValue: [{ timestamp: new Date().toISOString(), sampledValue: sampledValues }],
        };

    this.client.sendCall('MeterValues', payload).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        !msg.includes('not open') &&
        !msg.includes('timed out') &&
        !msg.includes('Not connected') &&
        !msg.includes('disconnected')
      ) {
        console.warn(`[clock-aligned] ${this.config.stationId}: ${msg}`);
      }
    });
    return Promise.resolve();
  }

  getAlignedIntervalSeconds(): number {
    if (this.is16) {
      const raw = Number(this.getConfigValue('ClockAlignedDataInterval') ?? '900');
      return isNaN(raw) || raw < 0 ? 0 : raw;
    }
    const raw = Number(this.getConfigValue('AlignedDataCtrlr.Interval') ?? '900');
    return isNaN(raw) || raw < 0 ? 0 : raw;
  }

  // ---------------------------------------------------------------------------
  // CSMS Command Handler (private)
  // ---------------------------------------------------------------------------

  private async handleCsmsCommand(
    _messageId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    console.log(`[${this.config.stationId}] Received ${action} from CSMS`);

    // Per OCPP spec: a station in Rejected boot state must not accept CSMS commands.
    // OCPP 2.1: respond with CALLERROR SecurityError (except TriggerMessage for BootNotification)
    // OCPP 1.6: silently reject (1.6 does not have SecurityError CALLERROR)
    if (this.bootStatus === 'Rejected') {
      if (this.is16) {
        return { status: 'Rejected' };
      }
      const isTriggerBoot =
        action === 'TriggerMessage' &&
        (payload['requestedMessage'] as string) === 'BootNotification';
      if (!isTriggerBoot) {
        throw new Error('SecurityError: Station boot was rejected');
      }
    }

    // During Pending boot state, reject transaction-related commands
    // OCPP 2.1: RequestStartTransaction
    // OCPP 1.6: RemoteStartTransaction
    if (this.bootStatus === 'Pending') {
      if (action === 'RequestStartTransaction' || action === 'RemoteStartTransaction') {
        return { status: 'Rejected', statusInfo: { reasonCode: 'BootPending' } };
      }
    }

    switch (action) {
      case 'RequestStartTransaction': {
        const idToken = payload['idToken'] as Record<string, unknown>;
        const evseId = (payload['evseId'] as number | undefined) ?? 1;
        // Always use a remoteStartId for RequestStartTransaction so the CSS
        // sets triggerReason to 'RemoteStart'. Use the provided value or
        // generate one.
        const remoteStartId = (payload['remoteStartId'] as number | undefined) ?? 1;

        // Check if a transaction is already active on this EVSE
        const existingTx = await this.getActiveTransaction(evseId);
        if (existingTx != null) {
          return {
            status: 'Rejected',
            statusInfo: { reasonCode: 'TxInProgress' },
          };
        }

        // Check if EVSE is reserved for a different token
        const startTokenStr = idToken['idToken'] as string;
        for (const res of this.reservations.values()) {
          if (res.evseId === evseId || res.evseId === 0) {
            const tokenMatch = res.idToken === startTokenStr;
            const groupMatch = res.groupIdToken != null && res.groupIdToken === startTokenStr;
            if (!tokenMatch && !groupMatch) {
              return {
                status: 'Rejected',
                statusInfo: { reasonCode: 'ReservedForOtherToken' },
              };
            }
          }
        }

        try {
          const evseCtx = this.evseContexts.get(evseId) as EvseContext;

          // Store charging profile if provided (stamp _evseId for GetChargingProfiles filtering)
          const chargingProfile = payload['chargingProfile'] as Record<string, unknown> | undefined;
          if (chargingProfile != null) {
            const profileId = chargingProfile['id'] as number | undefined;
            if (profileId != null) {
              this.chargingProfilesCache.set(profileId, { ...chargingProfile, _evseId: evseId });
            }
          }

          // Spec-compliant accept-and-wait flow (OCTT TC_F_04_CS):
          // - Cable already plugged -> start the transaction immediately and
          //   include the transactionId in the response.
          // - Cable not yet plugged -> accept, arm the EVConnectionTimeOut
          //   pre-tx timer, and wait for plugIn() to drive beginTransaction
          //   via its existing auto-start path. If the timer fires first the
          //   authorization ends without a transaction (C01.FR.26).
          const reportedStatus21 = this.evseConnectorStatus.get(evseId);
          const PLUGGED_21 = new Set(['Occupied', 'EVConnected']);
          const cableEffective =
            evseCtx.cablePlugged || (reportedStatus21 != null && PLUGGED_21.has(reportedStatus21));
          const tokenStr = idToken['idToken'] as string;
          const tokenTypeStr = (idToken['type'] as string | undefined) ?? 'ISO14443';

          // F01.FR.01/02: authorize the idToken first only when AuthorizeRemoteStart is true
          const authorizeRemoteStart =
            this.getConfigValue('AuthCtrlr.AuthorizeRemoteStart') !== 'false';

          if (cableEffective) {
            if (!authorizeRemoteStart) {
              evseCtx.authorizedToken = tokenStr;
              evseCtx.authorizedTokenType = tokenTypeStr;
            }
            const txId = await this.startCharging(evseId, tokenStr, tokenTypeStr, remoteStartId);
            return { status: 'Accepted', transactionId: txId };
          }

          evseCtx.state = 'Authorized';
          evseCtx.authorizedToken = tokenStr;
          evseCtx.authorizedTokenType = tokenTypeStr;
          evseCtx.remoteStartId = remoteStartId;
          this.startEvConnectTimeoutTimerPreTx(evseId);
          if (authorizeRemoteStart) {
            // F01.FR.01: respond first, then authorize as for a local action
            setTimeout(() => {
              void this.authorizeRemoteStart(evseId, tokenStr, tokenTypeStr);
            }, 0);
          }
          return { status: 'Accepted' };
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : 'InternalError';
          return {
            status: 'Rejected',
            statusInfo: { reasonCode: reason },
          };
        }
      }

      case 'RequestStopTransaction': {
        const stopTxId = payload['transactionId'] as string;
        // Find the EVSE with this transaction
        const evseId = await this.findEvseForTransaction(stopTxId);
        if (evseId != null) {
          await this.stopCharging(evseId, 'Remote');
          return { status: 'Accepted' };
        }
        if (!this.is16) {
          return {
            status: 'Rejected',
            statusInfo: { reasonCode: 'UnknownTransaction' },
          };
        }
        return { status: 'Rejected' };
      }

      case 'RemoteStartTransaction': {
        const idTag16 = payload['idTag'] as string;
        const connId = (payload['connectorId'] as number | undefined) ?? 1;
        const ctx16 = this.evseContexts.get(connId);
        if (ctx16 == null) {
          return { status: 'Rejected' };
        }

        // Validate charging profile purpose if provided
        const rsProfile = payload['chargingProfile'] as Record<string, unknown> | undefined;
        if (rsProfile != null) {
          const rsPurpose = rsProfile['chargingProfilePurpose'] as string | undefined;
          if (rsPurpose != null && rsPurpose !== 'TxProfile') {
            return { status: 'Rejected' };
          }
        }

        // Reject if transaction already active on this connector
        if (ctx16.transactionId != null) {
          return { status: 'Rejected' };
        }

        // Spec-compliant accept-and-wait flow:
        // - Cable already plugged -> fire-and-forget startCharging so the
        //   StartTransaction follows the Accepted response. Log post-Accepted
        //   errors so guest sessions don't hang in payment_authorized.
        // - Cable not yet plugged -> accept, set state=Authorized, transition
        //   the connector to Preparing, and arm the ConnectionTimeOut timer.
        //   plugIn() auto-starts the transaction via its existing flow; if
        //   the timer fires first the simulator deauths and reverts to
        //   Available.
        const reportedStatus16 = this.evseConnectorStatus.get(connId);
        const PLUGGED_16 = new Set(['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE']);
        const cableEffective16 =
          ctx16.cablePlugged || (reportedStatus16 != null && PLUGGED_16.has(reportedStatus16));

        if (cableEffective16) {
          void (async () => {
            try {
              await this.startCharging(connId, idTag16);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.log(
                `[${this.config.stationId}] RemoteStartTransaction post-Accepted start failed: ${msg}`,
              );
            }
          })();
          return { status: 'Accepted' };
        }

        ctx16.state = 'Authorized';
        ctx16.authorizedToken = idTag16;
        ctx16.authorizedTokenType = 'ISO14443';
        const evse16 = this.config.evses.find((e) => e.evseId === connId);
        if (evse16 != null) {
          this.evseConnectorStatus.set(connId, 'Preparing');
          void this.sendStatusNotification(connId, evse16.connectorId, 'Preparing').catch(() => {});
          void this.updateEvseStatus(connId, 'Preparing').catch(() => {});
        }
        this.startConnectionTimeoutTimer(connId);
        return { status: 'Accepted' };
      }

      case 'RemoteStopTransaction': {
        const stopTxId16 = String(payload['transactionId']);
        const evseId16 = await this.findEvseForTransaction(stopTxId16);
        if (evseId16 != null) {
          await this.stopCharging(evseId16, 'Remote');
          return { status: 'Accepted' };
        }
        return { status: 'Rejected' };
      }

      case 'Reset': {
        let resetType = payload['type'] as string;
        const resetEvseId = payload['evseId'] as number | undefined;

        // Map OCPP 1.6 reset types to internal types
        if (this.is16) {
          if (resetType === 'Hard') resetType = 'Immediate';
          if (resetType === 'Soft') resetType = 'OnIdle';
        }

        console.log(
          `[${this.config.stationId}] Resetting (${resetType}${resetEvseId != null ? ` evseId=${String(resetEvseId)}` : ''})`,
        );

        // Check if any EVSE has an active transaction
        const anyActive = await this.hasAnyActiveTransaction();

        // Version-appropriate stop reason for immediate resets
        const immediateStopReason = this.is16 ? 'HardReset' : 'ImmediateReset';

        // ImmediateAndResume: reject if ResumptionTimeout is 0 or not set
        if (resetType === 'ImmediateAndResume') {
          const resumptionTimeout = this.configVariables.get('TxCtrlr.ResumptionTimeout');
          const timeout = resumptionTimeout != null ? Number(resumptionTimeout.value) : 0;
          if (timeout <= 0) {
            return { status: 'Rejected' };
          }
          // B13: keep the ongoing transactions, reset, then resume them. Runs
          // after the ResetResponse is sent (B13 scenario step 2 before step 3).
          setTimeout(() => {
            void this.resetAndResumeTransactions(resetEvseId).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[${this.config.stationId}] ImmediateAndResume reset failed: ${msg}`);
            });
          }, 0);
          return { status: 'Accepted' };
        }

        if (resetType === 'OnIdle' && anyActive) {
          if (this.is16) {
            // OCPP 1.6 Soft Reset: stop all transactions then reboot
            const softStopReason = 'SoftReset';
            for (const evse of this.config.evses) {
              const tx = await this.getActiveTransaction(evse.evseId);
              if (tx != null) {
                await this.stopCharging(evse.evseId, softStopReason);
              }
            }
            void this.simulateReset(resetType).catch(() => {});
            return { status: 'Accepted' };
          }
          this.pendingReset = resetType;
          return {
            status: 'Scheduled',
            statusInfo: { reasonCode: 'TransactionInProgress' },
          };
        }

        // Immediate reset: stop all active transactions first
        if (resetType === 'Immediate' && anyActive) {
          for (const evse of this.config.evses) {
            const tx = await this.getActiveTransaction(evse.evseId);
            if (tx != null) {
              await this.stopCharging(evse.evseId, immediateStopReason);
            }
          }
        }

        void this.simulateReset(resetType).catch(() => {});
        return { status: 'Accepted' };
      }

      case 'UnlockConnector': {
        const unlockEvseId =
          (payload['evseId'] as number | undefined) ??
          (payload['connectorId'] as number | undefined) ??
          1;
        const unlockConnectorId = this.is16
          ? undefined
          : (payload['connectorId'] as number | undefined);
        console.log(
          `[${this.config.stationId}] Unlocking connector on EVSE ${String(unlockEvseId)}`,
        );

        // Validate EVSE exists
        const unlockEvse = this.config.evses.find((e) => e.evseId === unlockEvseId);
        if (unlockEvse == null) {
          return { status: this.is16 ? 'NotSupported' : 'UnknownConnector' };
        }

        // OCPP 2.1: validate connectorId matches the EVSE's connector
        if (
          !this.is16 &&
          unlockConnectorId != null &&
          unlockConnectorId !== unlockEvse.connectorId
        ) {
          return { status: 'UnknownConnector' };
        }

        // OCPP 1.6: a fixed cable has no connector lock to release.
        if (this.is16 && unlockEvse.fixedCable === true) {
          return { status: 'NotSupported' };
        }

        // A jammed lock cannot be released: report the lock failure after answering.
        if (this.jammedLocks.has(unlockEvseId)) {
          setTimeout(() => {
            void this.injectFault(unlockEvseId, 'ConnectorLockFailure').catch(() => {});
          }, 0);
          return { status: 'UnlockFailed' };
        }

        // Check if connector is unavailable
        if (this.availabilityState === 'Inoperative' || this.availabilityState === 'Unavailable') {
          return { status: 'UnlockFailed' };
        }

        // OCPP 2.1: If a transaction is active, return OngoingAuthorizedTransaction
        const unlockTx = await this.getActiveTransaction(unlockEvseId);
        if (unlockTx != null) {
          if (this.is16) {
            await this.stopCharging(unlockEvseId, 'UnlockCommand');
          } else {
            return { status: 'OngoingAuthorizedTransaction' };
          }
        }

        // Send StatusNotification Available after unlock
        const unlockConnId = this.getConnectorId(unlockEvseId);
        await this.sendStatusNotification(unlockEvseId, unlockConnId, 'Available');
        await this.updateEvseStatus(unlockEvseId, 'Available');
        const unlockCtx = this.evseContexts.get(unlockEvseId) as EvseContext;
        unlockCtx.state = 'Available';
        unlockCtx.cablePlugged = false;
        this.evseConnectorStatus.set(unlockEvseId, 'Available');

        return { status: 'Unlocked' };
      }

      case 'ChangeAvailability': {
        let newAvail: string;
        if (this.is16) {
          newAvail = payload['type'] as string;
          const connId16 = (payload['connectorId'] as number | undefined) ?? 0;
          console.log(
            `[${this.config.stationId}] Availability -> ${newAvail} (connector ${String(connId16)})`,
          );
        } else {
          newAvail = payload['operationalStatus'] as string;
          console.log(`[${this.config.stationId}] Availability -> ${newAvail}`);
        }
        this.availabilityState = newAvail;

        const goingUnavailable = newAvail === 'Inoperative' || newAvail === 'Unavailable';

        // Determine target EVSEs from the payload
        let targetEvseId: number | undefined;
        if (!this.is16) {
          const evseObj = payload['evse'] as Record<string, unknown> | undefined;
          targetEvseId = evseObj?.['id'] as number | undefined;
        }

        // Track per-EVSE administrative state regardless of whether the change
        // applies now or is scheduled. The clamp on the transaction-end
        // restoration paths reads this set, so it must be set before returning
        // Scheduled while a transaction is still active.
        for (const evse of this.config.evses) {
          if (targetEvseId != null && targetEvseId !== 0 && evse.evseId !== targetEvseId) continue;
          if (goingUnavailable) {
            this.evseAdminUnavailable.add(evse.evseId);
          } else {
            this.evseAdminUnavailable.delete(evse.evseId);
          }
        }

        const anyActiveTx = await this.hasAnyActiveTransaction();
        if (anyActiveTx) {
          return { status: 'Scheduled' };
        }

        const statusValue = goingUnavailable ? 'Unavailable' : 'Available';

        for (const evse of this.config.evses) {
          // If a specific EVSE was targeted, only change that one
          if (targetEvseId != null && targetEvseId !== 0 && evse.evseId !== targetEvseId) continue;
          this.evseConnectorStatus.set(evse.evseId, statusValue);
          const availCtx = this.evseContexts.get(evse.evseId) as EvseContext;
          availCtx.state = statusValue;
          void this.sendStatusNotification(evse.evseId, evse.connectorId, statusValue).catch(
            () => {},
          );
        }

        // Cancel reservations on EVSEs going unavailable
        if (statusValue === 'Unavailable') {
          for (const [resId, res] of this.reservations) {
            const affectsEvse =
              targetEvseId == null ||
              targetEvseId === 0 ||
              res.evseId === targetEvseId ||
              res.evseId === 0;
            if (affectsEvse) {
              this.clearReservationTimer(resId);
              this.reservations.delete(resId);
              void this.sendReservationStatusUpdate(resId, 'Removed').catch(() => {});
            }
          }
        }

        return { status: 'Accepted' };
      }

      case 'TriggerMessage': {
        const requestedMessage = payload['requestedMessage'] as string;
        const customTrigger = payload['customTrigger'] as string | undefined;
        console.log(`[${this.config.stationId}] TriggerMessage: ${requestedMessage}`);

        const validMessages16 = [
          'BootNotification',
          'DiagnosticsStatusNotification',
          'FirmwareStatusNotification',
          'Heartbeat',
          'MeterValues',
          'StatusNotification',
        ];
        const validMessages21 = [
          'BootNotification',
          'FirmwareStatusNotification',
          'Heartbeat',
          'MeterValues',
          'StatusNotification',
          'LogStatusNotification',
          'TransactionEvent',
          'SignChargingStationCertificate',
          'SignV2GCertificate',
          'PublishFirmwareStatusNotification',
          'CustomTrigger',
        ];
        const validSet = this.is16 ? validMessages16 : validMessages21;

        if (!validSet.includes(requestedMessage)) {
          return { status: 'NotImplemented' };
        }

        // OCPP 2.1: Reject BootNotification trigger if already booted successfully
        if (
          !this.is16 &&
          requestedMessage === 'BootNotification' &&
          this.bootStatus === 'Accepted'
        ) {
          return { status: 'Rejected' };
        }

        // OCPP 2.1: CustomTrigger validation
        if (!this.is16 && requestedMessage === 'CustomTrigger') {
          if (customTrigger == null || !this.customTriggers.includes(customTrigger)) {
            return { status: 'NotImplemented' };
          }
        }

        // Validate connectorId/evseId if provided
        const triggerEvseObj = payload['evse'] as Record<string, unknown> | undefined;
        const triggerConnId =
          (payload['connectorId'] as number | undefined) ??
          (triggerEvseObj?.['id'] as number | undefined);
        if (triggerConnId != null && triggerConnId > 0) {
          const triggerEvse = this.config.evses.find((e) => e.evseId === triggerConnId);
          if (triggerEvse == null) {
            return { status: 'Rejected' };
          }
        }

        setTimeout(() => {
          void this.handleTriggerMessage(requestedMessage, payload).catch(() => {});
        }, 100);
        return { status: 'Accepted' };
      }

      case 'GetVariables': {
        const getVarData = (payload['getVariableData'] ?? []) as Array<Record<string, unknown>>;
        return {
          getVariableResult: getVarData.map((item) => {
            const comp = item['component'] as Record<string, unknown>;
            const vari = item['variable'] as Record<string, unknown>;
            const compName = comp['name'] as string;
            const varName = vari['name'] as string;
            const varInstance =
              (comp['instance'] as string | undefined) ?? (vari['instance'] as string | undefined);
            const evseObj = comp['evse'] as Record<string, unknown> | undefined;
            const evseId = evseObj?.['id'] as number | undefined;
            const connectorId = evseObj?.['connectorId'] as number | undefined;
            const reqAttrType = (item['attributeType'] as string | undefined) ?? 'Actual';

            // Per-EVSE keys are stored with a `Component[evseId,connectorId]`
            // or `Component[evseId]` prefix on the component name, so the
            // existence probe must accept both the dotted and bracketed forms.
            let componentExists = false;
            for (const key of this.configVariables.keys()) {
              if (key.startsWith(compName + '.') || key.startsWith(compName + '[')) {
                componentExists = true;
                break;
              }
            }

            if (!componentExists) {
              return {
                attributeStatus: 'UnknownComponent',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }

            // Resolve the storage key. Per-EVSE Connector/EVSE variables live
            // under scoped keys like `Connector[1,1].ConnectorType` so
            // NotifyReport can attach `component.evse`. Walk scope and
            // instance permutations from most-specific to least-specific.
            const scopeSuffix =
              evseId != null && connectorId != null
                ? `[${String(evseId)},${String(connectorId)}]`
                : evseId != null
                  ? `[${String(evseId)}]`
                  : '';
            const candidates: string[] = [];
            if (scopeSuffix !== '' && varInstance != null) {
              candidates.push(`${compName}${scopeSuffix}.${varName}#${varInstance}`);
            }
            if (scopeSuffix !== '') {
              candidates.push(`${compName}${scopeSuffix}.${varName}`);
            }
            if (varInstance != null) {
              candidates.push(`${compName}.${varName}#${varInstance}`);
            }
            candidates.push(`${compName}.${varName}`);

            let entry: { value: string; readonly: boolean } | undefined;
            for (const k of candidates) {
              entry = this.configVariables.get(k);
              if (entry != null) break;
            }
            if (entry == null) {
              return {
                attributeStatus: 'UnknownVariable',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }

            // Only Actual attribute type is supported
            if (reqAttrType !== 'Actual') {
              return {
                attributeStatus: 'NotSupportedAttributeType',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }

            // B06.FR.09: a WriteOnly variable cannot be read
            if (WRITE_ONLY_VARIABLES.has(`${compName}.${varName}`)) {
              return {
                attributeStatus: 'Rejected',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }

            return {
              attributeStatus: 'Accepted',
              attributeType: reqAttrType,
              attributeValue: entry.value,
              component: item['component'],
              variable: item['variable'],
            };
          }),
        };
      }

      case 'SetVariables': {
        const setVarData = (payload['setVariableData'] ?? []) as Array<Record<string, unknown>>;
        const result = setVarData.map((item) => {
          const comp = item['component'] as Record<string, unknown>;
          const vari = item['variable'] as Record<string, unknown>;
          const compName = comp['name'] as string;
          const varName = vari['name'] as string;
          const compInstance =
            (comp['instance'] as string | undefined) ?? (vari['instance'] as string | undefined);
          const evseObj = comp['evse'] as Record<string, unknown> | undefined;
          const evseId = evseObj?.['id'] as number | undefined;
          const connectorId = evseObj?.['connectorId'] as number | undefined;
          const newValue = item['attributeValue'] as string;
          const reqAttrType = (item['attributeType'] as string | undefined) ?? 'Actual';

          // Per-EVSE keys are stored with a `Component[evseId,connectorId]`
          // or `Component[evseId]` prefix on the component name, so the
          // existence probe must accept both the dotted and bracketed forms.
          let componentExists = false;
          for (const key of this.configVariables.keys()) {
            if (key.startsWith(compName + '.') || key.startsWith(compName + '[')) {
              componentExists = true;
              break;
            }
          }

          if (!componentExists) {
            return {
              attributeStatus: 'UnknownComponent',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // Resolve the storage key. Per-EVSE Connector/EVSE variables live
          // under scoped keys like `Connector[1,1].ConnectorType`. Walk
          // scope and instance permutations from most-specific to
          // least-specific. The matching key becomes `effectiveKey` so the
          // write lands back on the same row.
          const scopeSuffix =
            evseId != null && connectorId != null
              ? `[${String(evseId)},${String(connectorId)}]`
              : evseId != null
                ? `[${String(evseId)}]`
                : '';
          const candidates: string[] = [];
          if (scopeSuffix !== '' && compInstance != null) {
            candidates.push(`${compName}${scopeSuffix}.${varName}#${compInstance}`);
          }
          if (scopeSuffix !== '') {
            candidates.push(`${compName}${scopeSuffix}.${varName}`);
          }
          if (compInstance != null) {
            candidates.push(`${compName}.${varName}#${compInstance}`);
          }
          candidates.push(`${compName}.${varName}`);

          let existing: { value: string; readonly: boolean } | undefined;
          let effectiveKey = candidates[candidates.length - 1] ?? `${compName}.${varName}`;
          for (const k of candidates) {
            const found = this.configVariables.get(k);
            if (found != null) {
              existing = found;
              effectiveKey = k;
              break;
            }
          }
          if (existing == null) {
            return {
              attributeStatus: 'UnknownVariable',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // Check if attribute type is supported (only Actual is supported)
          if (reqAttrType !== 'Actual') {
            return {
              attributeStatus: 'NotSupportedAttributeType',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // Check if readonly
          if (existing.readonly) {
            return {
              attributeStatus: 'Rejected',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // A00.FR.205: BasicAuthPassword is a passwordString of 16 to 40 characters
          if (
            varName === 'BasicAuthPassword' &&
            validateStationPassword(newValue, 'ocpp2.1') != null
          ) {
            return {
              attributeStatus: 'Rejected',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // WebPaymentsCtrlr value ranges (2.1 Part 2 Referenced Components and Variables)
          if (compName === 'WebPaymentsCtrlr' && !this.isValidWebPaymentsValue(varName, newValue)) {
            return {
              attributeStatus: 'Rejected',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          if (
            effectiveKey === CSS_STATUS_REPORTING_KEY &&
            !(CSS_STATUS_REPORTING_VALUES as readonly string[]).includes(newValue)
          ) {
            return {
              attributeStatus: 'Rejected',
              attributeType: reqAttrType,
              component: item['component'],
              variable: item['variable'],
            };
          }

          // Prevent security profile downgrade via SetVariables
          if (compName === 'NetworkConfiguration' && varName === 'SecurityProfile') {
            const currentSecProfile = Number(
              this.configVariables.get('SecurityCtrlr.SecurityProfile')?.value ?? '0',
            );
            const allowDowngrade =
              this.configVariables.get('SecurityCtrlr.AllowSecurityDowngrade')?.value === 'true';
            if (Number(newValue) < currentSecProfile && !allowDowngrade) {
              return {
                attributeStatus: 'Rejected',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }
          }

          // Prevent modifying NetworkConfiguration on the active slot
          if (compName === 'NetworkConfiguration' && compInstance != null) {
            const priority =
              this.configVariables.get('OCPPCommCtrlr.NetworkConfigurationPriority')?.value ?? '1';
            const activeSlot = priority.split(',')[0]?.trim();
            if (compInstance === activeSlot) {
              return {
                attributeStatus: 'Rejected',
                attributeType: reqAttrType,
                component: item['component'],
                variable: item['variable'],
              };
            }
          }

          // Validate NetworkConfigurationPriority: every slot needs a URL, a TLS profile a
          // valid CSMS root certificate (A05.FR.02) and profile 3 a valid Charging Station
          // certificate (A05.FR.03).
          if (compName === 'OCPPCommCtrlr' && varName === 'NetworkConfigurationPriority') {
            const slots = newValue.split(',').map((s) => s.trim());
            for (const slot of slots) {
              const url = this.configVariables.get(`NetworkConfiguration.OcppCsmsUrl#${slot}`);
              const slotProfile = Number(
                this.getConfigValue(`NetworkConfiguration.SecurityProfile#${slot}`) ?? '0',
              );
              if (
                url == null ||
                url.value === '' ||
                (slotProfile >= 2 && !this.hasValidCsmsRootCertificate()) ||
                (slotProfile === 3 && !this.hasValidChargingStationCertificate())
              ) {
                return {
                  attributeStatus: 'Rejected',
                  attributeType: reqAttrType,
                  component: item['component'],
                  variable: item['variable'],
                };
              }
            }
          }

          this.configVariables.set(effectiveKey, { value: newValue, readonly: false });
          if (compName === 'SecurityCtrlr' && varName === 'BasicAuthPassword') {
            this.applyNewPassword(newValue);
          }
          // N07: monitors on the variable see the new value after the response.
          // A write-only variable reports an empty actualValue.
          if (!this.is16) {
            const numeric = Number(newValue);
            const monitorValue = newValue !== '' && Number.isFinite(numeric) ? numeric : newValue;
            const writeOnly = WRITE_ONLY_VARIABLES.has(`${compName}.${varName}`);
            const events = this.evaluateMonitors(
              comp,
              varName,
              monitorValue,
              null,
              writeOnly ? '' : undefined,
            );
            if (events.length > 0) {
              setTimeout(() => {
                this.dispatchMonitorEvents(events);
              }, 0);
            }
          }

          return {
            attributeStatus: 'Accepted',
            attributeType: reqAttrType,
            component: item['component'],
            variable: item['variable'],
          };
        });
        return { setVariableResult: result };
      }

      case 'GetConfiguration': {
        const requestedKeys = payload['key'] as string[] | undefined;
        const configurationKey: Array<{ key: string; readonly: boolean; value: string }> = [];
        const unknownKey: string[] = [];

        if (requestedKeys != null && requestedKeys.length > 0) {
          for (const k of requestedKeys) {
            const entry = this.configVariables.get(k);
            if (entry != null) {
              configurationKey.push({
                key: k,
                readonly: entry.readonly,
                // AuthorizationKey is write-only (OCPP 1.6 Security Whitepaper).
                value: k === 'AuthorizationKey' ? '' : entry.value,
              });
            } else {
              unknownKey.push(k);
            }
          }
        } else {
          for (const [k, entry] of this.configVariables) {
            configurationKey.push({
              key: k,
              readonly: entry.readonly,
              // AuthorizationKey is write-only (OCPP 1.6 Security Whitepaper).
              value: k === 'AuthorizationKey' ? '' : entry.value,
            });
          }
        }

        return { configurationKey, unknownKey };
      }

      case 'ChangeConfiguration': {
        const cfgKey = payload['key'] as string;
        const cfgValue = payload['value'] as string;
        const existing = this.configVariables.get(cfgKey);

        // OCPP 1.6 Security Whitepaper: the Basic Auth password arrives hex-encoded,
        // 16-20 bytes (OCTT TC_073); the station reconnects with it.
        if (cfgKey === 'AuthorizationKey') {
          if (!/^(?:[0-9A-Fa-f]{2}){16,20}$/.test(cfgValue)) return { status: 'Rejected' };
          this.configVariables.set('AuthorizationKey', { value: cfgValue, readonly: false });
          this.applyNewPassword(Buffer.from(cfgValue, 'hex').toString('latin1'));
          return { status: 'Accepted' };
        }
        // Only an upgrade is allowed; it applies after the next reset.
        if (cfgKey === 'SecurityProfile') {
          const next = Number(cfgValue);
          const current = Number(this.getConfigValue('SecurityProfile') ?? '0');
          if (!Number.isInteger(next) || next <= current || next > 3) return { status: 'Rejected' };
          this.pendingSecurityProfile16 = next;
          return { status: 'Accepted' };
        }

        if (existing == null) {
          return { status: 'NotSupported' };
        }
        if (existing.readonly) {
          return { status: 'Rejected' };
        }

        // Validate integer configuration keys
        const integerKeys = new Set([
          'MeterValueSampleInterval',
          'HeartbeatInterval',
          'ConnectionTimeOut',
          'ClockAlignedDataInterval',
          'ResetRetries',
          'TransactionMessageAttempts',
          'TransactionMessageRetryInterval',
          'WebSocketPingInterval',
          'LocalAuthListMaxLength',
          'ChargeProfileMaxStackLevel',
          'ChargingScheduleMaxPeriods',
          'MaxChargingProfilesInstalled',
          'GetConfigurationMaxKeys',
          'NumberOfConnectors',
        ]);
        if (integerKeys.has(cfgKey)) {
          const numVal = Number(cfgValue);
          if (isNaN(numVal) || numVal < 0 || !Number.isInteger(numVal)) {
            return { status: 'Rejected' };
          }
        }

        this.configVariables.set(cfgKey, { value: cfgValue, readonly: existing.readonly });

        const rebootKeys = new Set(['WebSocketPingInterval', 'ConnectionTimeOut']);
        return { status: rebootKeys.has(cfgKey) ? 'RebootRequired' : 'Accepted' };
      }

      case 'ClearCache': {
        // OCPP 2.1: reject when AuthCacheCtrlr.Enabled is false
        if (!this.is16 && this.getConfigValue('AuthCacheCtrlr.Enabled') === 'false') {
          return { status: 'Rejected' };
        }
        this.clearAuthCache();
        return { status: 'Accepted' };
      }

      case 'GetBaseReport': {
        const baseReportRequestId = payload['requestId'] as number;
        if (!this.is16) {
          void this.sendNotifyReport(baseReportRequestId).catch(() => {});
        }
        return { status: 'Accepted' };
      }

      case 'GetReport': {
        const getReportRequestId = payload['requestId'] as number;
        const componentCriteria = payload['componentCriteria'] as string[] | undefined;
        const componentVariable = payload['componentVariable'] as
          | Array<{
              component: { name: string; evse?: { id: number }; instance?: string };
              variable: { name: string; instance?: string };
            }>
          | undefined;

        // Validate componentCriteria values
        const validCriteria = new Set(['Active', 'Available', 'Enabled', 'Problem']);
        if (componentCriteria != null) {
          const hasInvalid = componentCriteria.some((c) => !validCriteria.has(c));
          if (hasInvalid) {
            return { status: 'NotSupported' };
          }
        }

        if (!this.is16) {
          // Check if any variables match the filter before sending
          const matchCount = this.countMatchingVariables({
            componentCriteria: componentCriteria ?? undefined,
            componentVariable: componentVariable ?? undefined,
          });
          if (matchCount === 0) {
            return { status: 'EmptyResultSet' };
          }
          void this.sendNotifyReport(getReportRequestId, {
            componentCriteria: componentCriteria ?? undefined,
            componentVariable: componentVariable ?? undefined,
          }).catch(() => {});
        }
        return { status: 'Accepted' };
      }

      case 'SetChargingProfile': {
        const profile = (payload['csChargingProfiles'] ?? payload['chargingProfile']) as
          | Record<string, unknown>
          | undefined;
        const evseIdForProfile =
          (payload['evseId'] as number | undefined) ??
          (payload['connectorId'] as number | undefined) ??
          1;

        // Validate: TxProfile on connectorId 0 is rejected
        const profilePurpose = profile?.['chargingProfilePurpose'] as string | undefined;
        if (!this.is16 && profile != null) {
          const invalid = this.validateChargingProfile21(profile, evseIdForProfile);
          if (invalid != null) return invalid;
        }
        if (profilePurpose === 'TxProfile' && evseIdForProfile === 0) {
          return { status: 'Rejected' };
        }

        // Validate: TxProfile must have matching transactionId
        if (profilePurpose === 'TxProfile') {
          if (this.is16) {
            const profileTxId = profile?.['transactionId'] as number | undefined;
            if (profileTxId != null) {
              const activeTxForProfile = await this.getActiveTransaction(evseIdForProfile);
              if (
                activeTxForProfile == null ||
                Number(activeTxForProfile.transactionId) !== profileTxId
              ) {
                return { status: 'Rejected' };
              }
            }
          } else {
            // OCPP 2.1: TxProfile requires an active transaction on the specified EVSE
            const activeTxForProfile = await this.getActiveTransaction(evseIdForProfile);
            const profileTxId21 = profile?.['transactionId'] as string | undefined;
            if (activeTxForProfile == null) {
              return { status: 'Rejected' };
            }
            if (profileTxId21 != null && activeTxForProfile.transactionId !== profileTxId21) {
              return { status: 'Rejected' };
            }
          }
        }

        // Extract power limit
        const schedule = (
          (profile?.['chargingSchedule'] ?? []) as Array<Record<string, unknown>>
        )[0];
        const periods = (
          (schedule?.['chargingSchedulePeriod'] ?? []) as Array<Record<string, unknown>>
        )[0];
        const limit = periods?.['limit'] as number | undefined;
        if (limit != null) {
          this.evsePowerLimits.set(evseIdForProfile, limit);
          console.log(
            `[${this.config.stationId}] SetChargingProfile: power limit set to ${String(limit)} W on EVSE ${String(evseIdForProfile)}`,
          );
        }

        // Store in memory cache (stamp _evseId and _chargingLimitSource for GetChargingProfiles)
        if (profile != null) {
          const profileId =
            (profile['id'] as number | undefined) ??
            (profile['chargingProfileId'] as number | undefined) ??
            0;
          const source = profilePurpose === 'ChargingStationExternalConstraints' ? 'EMS' : 'CSO';
          this.chargingProfilesCache.set(profileId, {
            ...profile,
            _evseId: evseIdForProfile,
            _chargingLimitSource: source,
            _setAt: new Date().toISOString(),
          });
        }

        return { status: 'Accepted' };
      }

      case 'ClearChargingProfile': {
        const clearProfileId = payload['chargingProfileId'] as number | undefined;
        const clearCriteria = payload['chargingProfileCriteria'] as
          | Record<string, unknown>
          | undefined;

        // OCPP 1.6: simple clear all
        if (this.is16) {
          for (const evse of this.config.evses) {
            this.evsePowerLimits.set(evse.evseId, null);
          }
          this.chargingProfilesCache.clear();
          console.log(`[${this.config.stationId}] ClearChargingProfile: power limits cleared`);
          return { status: 'Accepted' };
        }

        // OCPP 2.1: filter and clear matching profiles
        let cleared = false;
        if (clearProfileId != null) {
          if (this.chargingProfilesCache.has(clearProfileId)) {
            this.chargingProfilesCache.delete(clearProfileId);
            cleared = true;
          }
        } else if (clearCriteria != null) {
          const critPurpose = clearCriteria['chargingProfilePurpose'] as string | undefined;
          const critStackLevel = clearCriteria['stackLevel'] as number | undefined;
          const toDelete: number[] = [];
          for (const [profileId, profile] of this.chargingProfilesCache.entries()) {
            let matches = true;
            if (critPurpose != null && profile['chargingProfilePurpose'] !== critPurpose)
              matches = false;
            if (critStackLevel != null && profile['stackLevel'] !== critStackLevel) matches = false;
            if (matches) toDelete.push(profileId);
          }
          for (const profileId of toDelete) {
            this.chargingProfilesCache.delete(profileId);
            cleared = true;
          }
        } else {
          if (this.chargingProfilesCache.size > 0) cleared = true;
          this.chargingProfilesCache.clear();
        }

        if (cleared) {
          for (const evse of this.config.evses) {
            this.evsePowerLimits.set(evse.evseId, null);
          }
          console.log(`[${this.config.stationId}] ClearChargingProfile: power limits cleared`);
          return { status: 'Accepted' };
        }
        return { status: 'Unknown' };
      }

      case 'GetCompositeSchedule': {
        const gcs_rateUnit = (payload['chargingRateUnit'] as string | undefined) ?? 'A';
        if (this.is16) {
          const gcs_connId = (payload['connectorId'] as number | undefined) ?? 1;
          const gcs_dur16 = (payload['duration'] as number | undefined) ?? 86400;
          return {
            status: 'Accepted',
            connectorId: gcs_connId,
            scheduleStart: new Date().toISOString(),
            chargingSchedule: {
              chargingRateUnit: gcs_rateUnit,
              chargingSchedulePeriod: [
                { startPeriod: 0, limit: 11000, numberPhases: 3 },
                { startPeriod: 3600, limit: 22000, numberPhases: 3 },
              ],
              duration: gcs_dur16,
            },
          };
        }
        // OCPP 2.1 K08
        const gcs_evseId = (payload['evseId'] as number | undefined) ?? 0;
        const gcs_duration = (payload['duration'] as number | undefined) ?? 86400;
        // Reject unsupported chargingRateUnit (SmartChargingCtrlr.RateUnit)
        if (!this.supportedRateUnits().includes(gcs_rateUnit)) {
          return { status: 'Rejected', statusInfo: { reasonCode: 'UnsupportedRateUnit' } };
        }
        // Reject unknown EVSE IDs (0 is station-level, always valid)
        const gcs_evses =
          gcs_evseId === 0
            ? this.config.evses
            : this.config.evses.filter((e) => e.evseId === gcs_evseId);
        if (gcs_evses.length === 0) {
          return { status: 'Rejected', statusInfo: { reasonCode: 'UnknownEVSE' } };
        }
        const gcs_now = new Date();
        const gcs_txId = gcs_evseId === 0 ? null : this.getActiveTransactionSync(gcs_evseId);
        const gcs_txStart = gcs_evseId === 0 ? null : this.evseTransactionStartTime.get(gcs_evseId);
        const gcs_periods = computeCompositeSchedule({
          profiles: Array.from(this.chargingProfilesCache.values()),
          evseId: gcs_evseId,
          now: gcs_now,
          durationS: gcs_duration,
          // Local limit: the EVSE hardware power (W) or current (A), summed for the station
          localLimit: gcs_evses.reduce(
            (sum, e) =>
              sum +
              (gcs_rateUnit === 'W'
                ? e.maxPowerW
                : Math.round(e.maxPowerW / (e.voltage * Math.max(1, e.phases)))),
            0,
          ),
          unit: gcs_rateUnit === 'W' ? 'W' : 'A',
          voltage: gcs_evses[0]?.voltage ?? 230,
          numberPhases: Math.max(...gcs_evses.map((e) => e.phases)),
          transactionId: gcs_txId,
          transactionStart: gcs_txStart != null ? new Date(gcs_txStart) : null,
        });
        return {
          status: 'Accepted',
          schedule: {
            evseId: gcs_evseId,
            duration: gcs_duration,
            scheduleStart: gcs_now.toISOString(),
            chargingRateUnit: gcs_rateUnit,
            chargingSchedulePeriod: gcs_periods,
          },
        };
      }

      case 'GetChargingProfiles': {
        const cpRequestId = payload['requestId'] as number;
        const cpEvseId = payload['evseId'] as number | undefined;
        const cpSource = (payload['chargingLimitSource'] as string | undefined) ?? 'CSO';
        const cpCriteria = payload['chargingProfile'] as Record<string, unknown> | undefined;

        // PersistedCache is the source of truth and is loaded at boot. A DB
        // fallback would race the fire-and-forget DELETE from a preceding
        // ClearChargingProfile and resurrect just-deleted rows.
        const allProfiles: Array<Record<string, unknown>> = Array.from(
          this.chargingProfilesCache.values(),
        );

        // Filter by evseId: if specified, only return profiles for that EVSE
        // evseId=0 means station-level profiles only; omitted means all profiles
        let filtered = allProfiles;
        if (cpEvseId != null) {
          filtered = filtered.filter((p) => (p['_evseId'] as number | undefined) === cpEvseId);
        }
        if (cpCriteria != null) {
          const rawProfileId = cpCriteria['chargingProfileId'];
          const filterProfileIds: number[] | undefined = Array.isArray(rawProfileId)
            ? rawProfileId
            : typeof rawProfileId === 'number'
              ? [rawProfileId]
              : undefined;
          const filterPurpose = cpCriteria['chargingProfilePurpose'] as string | undefined;
          const filterStackLevel = cpCriteria['stackLevel'] as number | undefined;
          const rawSource = cpCriteria['chargingLimitSource'];
          const filterSources: string[] | undefined = Array.isArray(rawSource)
            ? rawSource
            : typeof rawSource === 'string'
              ? [rawSource]
              : undefined;
          filtered = filtered.filter((p) => {
            if (filterProfileIds != null) {
              const pId =
                (p['id'] as number | undefined) ?? (p['chargingProfileId'] as number | undefined);
              if (pId == null || !filterProfileIds.includes(pId)) return false;
            }
            if (filterPurpose != null && p['chargingProfilePurpose'] !== filterPurpose)
              return false;
            if (filterStackLevel != null && p['stackLevel'] !== filterStackLevel) return false;
            if (filterSources != null) {
              const profileSource = (p['_chargingLimitSource'] as string | undefined) ?? 'CSO';
              if (!filterSources.includes(profileSource)) return false;
            }
            return true;
          });
        }

        if (filtered.length === 0) {
          return { status: 'NoProfiles' };
        }

        if (!this.is16) {
          // K09: one ReportChargingProfilesRequest per EVSE and limit source,
          // tbc on all but the last; internal stamps are not reported.
          const groups = new Map<string, Array<Record<string, unknown>>>();
          for (const p of filtered) {
            const evse = (p['_evseId'] as number | undefined) ?? 0;
            const source = (p['_chargingLimitSource'] as string | undefined) ?? cpSource;
            const key = `${String(evse)}|${source}`;
            const {
              _evseId: _unused,
              _chargingLimitSource: _unused2,
              _setAt: _unused3,
              _invalidated: _unused4,
              ...rest
            } = p;
            void _unused;
            void _unused2;
            void _unused3;
            void _unused4;
            groups.set(key, [...(groups.get(key) ?? []), rest]);
          }
          const reports = Array.from(groups.entries());
          setTimeout(() => {
            void (async () => {
              for (const [i, [key, profiles]] of reports.entries()) {
                const [evse, source] = key.split('|');
                await this.client.sendCall('ReportChargingProfiles', {
                  requestId: cpRequestId,
                  chargingLimitSource: source,
                  chargingProfile: profiles,
                  evseId: Number(evse),
                  tbc: i < reports.length - 1,
                });
              }
            })().catch(() => {});
          }, 200);
        }
        return { status: 'Accepted' };
      }

      case 'ReserveNow': {
        // Check if reservation feature is supported
        if (this.is16) {
          const profiles = this.getConfigValue('SupportedFeatureProfiles') ?? '';
          if (!profiles.includes('Reservation')) {
            return { status: 'Rejected' };
          }
        } else {
          const resEnabled = this.getConfigValue('ReservationCtrlr.Enabled');
          if (resEnabled === 'false') {
            return { status: 'Rejected', statusInfo: { reasonCode: 'UnavailableReservation' } };
          }
        }

        let reservationId: number;
        let reserveEvseId: number;
        let reserveIdTokenStr: string;
        let expiryDateTime: string;

        let groupIdTokenStr: string | undefined;
        let reserveConnectorType: string | undefined;

        if (this.is16) {
          reservationId = payload['reservationId'] as number;
          reserveEvseId = (payload['connectorId'] as number | undefined) ?? 1;
          reserveIdTokenStr = payload['idTag'] as string;
          expiryDateTime = payload['expiryDate'] as string;
        } else {
          reservationId = payload['id'] as number;
          // OCPP 2.1: omitted evseId means "any EVSE" (0)
          reserveEvseId = (payload['evseId'] as number | undefined) ?? 0;
          const reserveIdToken = payload['idToken'] as Record<string, unknown>;
          reserveIdTokenStr = reserveIdToken['idToken'] as string;
          expiryDateTime = payload['expiryDateTime'] as string;
          const gidToken = payload['groupIdToken'] as Record<string, unknown> | undefined;
          if (gidToken != null) {
            groupIdTokenStr = gidToken['idToken'] as string;
          }
          reserveConnectorType = payload['connectorType'] as string | undefined;
        }

        // If same reservation ID exists, this is a replacement. Remove old one first.
        const existingRes = this.reservations.get(reservationId);
        if (existingRes != null) {
          this.clearReservationTimer(reservationId);
          this.reservations.delete(reservationId);
        }

        // Filter EVSEs by connectorType if specified (OCPP 2.1)
        // Map OCPP 2.1 connector type enum to internal CSS type
        const ocppToInternalType: Record<string, string> = {
          cType2: 'ac_type2',
          cType1: 'ac_type1',
          cCCS2: 'dc_ccs2',
          cCCS1: 'dc_ccs1',
          cCHAdeMO: 'dc_chademo',
        };
        const candidateEvses =
          reserveConnectorType != null
            ? this.config.evses.filter(
                (e) =>
                  e.connectorType === reserveConnectorType ||
                  e.connectorType === ocppToInternalType[reserveConnectorType],
              )
            : this.config.evses;

        // Check connector status
        // For connectorId 0 (any connector), check all connectors
        if (reserveEvseId === 0) {
          let hasFaulted = false;
          let allUnavailable = true;
          let allOccupiedOrReserved = true;
          for (const evse of candidateEvses) {
            const status = this.evseConnectorStatus.get(evse.evseId) ?? 'Available';
            if (status === 'Faulted') hasFaulted = true;
            if (status !== 'Unavailable') allUnavailable = false;
            const isOccupied =
              status === 'Charging' || status === 'Occupied' || status === 'Preparing';
            const isReserved = status === 'Reserved';
            if (!isOccupied && !isReserved) allOccupiedOrReserved = false;
          }
          // Also count in-memory reservations for EVSEs that might still show Available
          // (race between reservation set and StatusNotification)
          if (!allOccupiedOrReserved) {
            let allBusyOrReserved = true;
            for (const evse of candidateEvses) {
              const status = this.evseConnectorStatus.get(evse.evseId) ?? 'Available';
              const isOccupied =
                status === 'Charging' || status === 'Occupied' || status === 'Preparing';
              let hasReservation = status === 'Reserved';
              if (!hasReservation) {
                for (const r of this.reservations.values()) {
                  if (r.evseId === evse.evseId || r.evseId === 0) {
                    hasReservation = true;
                    break;
                  }
                }
              }
              if (!isOccupied && !hasReservation) {
                allBusyOrReserved = false;
                break;
              }
            }
            allOccupiedOrReserved = allBusyOrReserved;
          }
          if (hasFaulted) return { status: 'Faulted' };
          if (allUnavailable) return { status: 'Unavailable' };
          if (allOccupiedOrReserved) return { status: 'Occupied' };
        } else {
          const connStatus = this.evseConnectorStatus.get(reserveEvseId) ?? 'Available';
          if (connStatus === 'Faulted') return { status: 'Faulted' };
          if (connStatus === 'Unavailable') return { status: 'Unavailable' };
          if (
            connStatus === 'Charging' ||
            connStatus === 'Occupied' ||
            connStatus === 'Preparing'
          ) {
            return { status: 'Occupied' };
          }
        }

        // Check for active transaction on this EVSE
        const activeTx = reserveEvseId > 0 ? await this.getActiveTransaction(reserveEvseId) : null;
        if (activeTx != null) {
          const occupiedResponse: Record<string, unknown> = { status: 'Occupied' };
          if (!this.is16) {
            occupiedResponse['statusInfo'] = { reasonCode: 'TransactionInProgress' };
          }
          return occupiedResponse;
        }

        // Check for existing reservation on this EVSE (different reservation ID)
        let evseReserved = false;
        for (const r of this.reservations.values()) {
          if (r.evseId === reserveEvseId) {
            evseReserved = true;
            break;
          }
        }
        if (evseReserved) {
          return { status: 'Occupied' };
        }

        // For unspecified EVSE (evseId=0), pick a free EVSE from candidates
        let assignedEvseId = reserveEvseId;
        if (reserveEvseId === 0) {
          for (const evse of candidateEvses) {
            const status = this.evseConnectorStatus.get(evse.evseId) ?? 'Available';
            if (status === 'Available') {
              let hasRes = false;
              for (const r of this.reservations.values()) {
                if (r.evseId === evse.evseId) {
                  hasRes = true;
                  break;
                }
              }
              if (!hasRes) {
                assignedEvseId = evse.evseId;
                break;
              }
            }
          }
          // If no free EVSE found, keep evseId=0 (reservation for any)
        }

        this.reservations.set(reservationId, {
          id: reservationId,
          evseId: assignedEvseId,
          idToken: reserveIdTokenStr,
          ...(groupIdTokenStr != null ? { groupIdToken: groupIdTokenStr } : {}),
          ...(reserveConnectorType != null ? { connectorType: reserveConnectorType } : {}),
          expiryDateTime,
        });
        const expiryMs = new Date(expiryDateTime).getTime() - Date.now();
        this.scheduleReservationExpiry(reservationId, expiryMs);

        console.log(
          `[${this.config.stationId}] Reservation ${String(reservationId)} accepted for EVSE ${String(assignedEvseId)}`,
        );
        if (assignedEvseId > 0) {
          this.evseConnectorStatus.set(assignedEvseId, 'Reserved');
          void this.sendStatusNotification(
            assignedEvseId,
            this.getConnectorId(assignedEvseId),
            'Reserved',
          ).catch(() => {});
        }
        return { status: 'Accepted' };
      }

      case 'CancelReservation': {
        const cancelId = payload['reservationId'] as number;
        const reservation = this.reservations.get(cancelId);
        if (reservation == null) {
          if (!this.is16) {
            return {
              status: 'Rejected',
              statusInfo: { reasonCode: 'UnknownReservation' },
            };
          }
          return { status: 'Rejected' };
        }
        this.clearReservationTimer(cancelId);
        this.reservations.delete(cancelId);
        console.log(`[${this.config.stationId}] Reservation ${String(cancelId)} cancelled`);
        if (reservation.evseId > 0) {
          this.evseConnectorStatus.set(reservation.evseId, 'Available');
        }
        void this.sendReservationStatusUpdate(cancelId, 'Removed').catch(() => {});
        void this.sendStatusNotification(
          reservation.evseId,
          this.getConnectorId(reservation.evseId),
          'Available',
        ).catch(() => {});
        return { status: 'Accepted' };
      }

      case 'CertificateSigned': {
        if (this.is16) return this.certificateSigned16(payload);
        const certType =
          (payload['certificateType'] as string | undefined) ?? 'ChargingStationCertificate';
        console.log(`[${this.config.stationId}] CertificateSigned: ${certType}`);
        return this.handleCertificateSigned(payload);
      }

      case 'DeleteCertificate': {
        if (this.is16) return this.deleteCertificate16(payload);
        const hashData = payload['certificateHashData'] as Record<string, string> | undefined;
        const serial = hashData?.['serialNumber'] ?? '';
        // Check in-memory cache first
        if (this.installedCertificatesCache.has(serial)) {
          const entry = this.installedCertificatesCache.get(serial);
          // Refuse to delete CSMSRootCertificate (station's own trust anchor)
          if (entry?.certificateType === 'CSMSRootCertificate') {
            return { status: 'Failed' };
          }
          this.installedCertificatesCache.delete(serial);
          console.log(`[${this.config.stationId}] DeleteCertificate: removed ${serial}`);
          return { status: 'Accepted' };
        }
        return { status: 'NotFound' };
      }

      case 'GetInstalledCertificateIds': {
        if (this.is16) return this.getInstalledCertificateIds16(payload);
        const requestedTypes = payload['certificateType'] as string[] | undefined;

        // Build cert chain from in-memory cache (loaded from DB + defaults on startup,
        // updated by InstallCertificate/DeleteCertificate)
        type CertEntry = {
          certificateType: string;
          certificateHashData: Record<string, string>;
          childCertificateHashData?: Array<Record<string, string>>;
        };
        let certChain: CertEntry[] = [];
        for (const entry of this.installedCertificatesCache.values()) {
          const item: CertEntry = {
            certificateType: entry.certificateType,
            certificateHashData: { ...entry.certificateHashData },
          };
          // V2GCertificateChain includes child certificate hash data
          if (entry.certificateType === 'V2GCertificateChain') {
            item.childCertificateHashData = [
              {
                hashAlgorithm: 'SHA256',
                issuerNameHash: entry.certificateHashData['issuerNameHash'] ?? '',
                issuerKeyHash: entry.certificateHashData['issuerKeyHash'] ?? '',
                serialNumber: `${entry.certificateHashData['serialNumber'] ?? ''}-child`,
              },
            ];
          }
          certChain.push(item);
        }

        // Filter by requested types if specified
        if (requestedTypes != null && requestedTypes.length > 0) {
          certChain = certChain.filter((c) => requestedTypes.includes(c.certificateType));
        }

        if (certChain.length === 0) {
          return { status: 'NotFound' };
        }

        return {
          status: 'Accepted',
          certificateHashDataChain: certChain,
        };
      }

      case 'InstallCertificate': {
        if (this.is16) return this.installCertificate16(payload);
        const installType =
          (payload['certificateType'] as string | undefined) ?? 'CSMSRootCertificate';
        const certPem = (payload['certificate'] as string | undefined) ?? '';

        // Reject obviously invalid certificates (expired, unsigned, too short to be valid PEM)
        if (
          certPem.includes('EXPIRED') ||
          certPem.includes('UNSIGNED') ||
          (certPem.length < 50 && !certPem.startsWith('MII'))
        ) {
          return { status: 'Rejected' };
        }

        const installSerial = randomUUID().slice(0, 8);
        const issuerNameHash = randomUUID().replace(/-/g, '').slice(0, 40);
        const issuerKeyHash = randomUUID().replace(/-/g, '').slice(0, 40);
        const parsed = parseCertificateChain(certPem)?.[0];
        // A real certificate must be within its validity period.
        if (parsed != null && !isWithinValidity(parsed)) {
          return { status: 'Rejected' };
        }

        this.installedCertificatesCache.set(installSerial, {
          certificateType: installType,
          certificateHashData: {
            hashAlgorithm: 'SHA256',
            issuerNameHash,
            issuerKeyHash,
            serialNumber: installSerial,
          },
          ...(parsed != null ? { certificate: parsed.toString() } : {}),
        });

        // A real CSMS root joins the TLS trust store of the CSMS connection.
        if (installType === 'CSMSRootCertificate' && parsed != null) {
          this.refreshTrustAnchors();
        }

        console.log(
          `[${this.config.stationId}] InstallCertificate: ${installType} (${installSerial})`,
        );

        return { status: 'Accepted' };
      }

      case 'ExtendedTriggerMessage':
        if (this.is16) return this.extendedTriggerMessage16(payload);
        return { status: 'NotSupported' };

      case 'SignedUpdateFirmware':
        if (this.is16) return this.signedUpdateFirmware16(payload);
        return { status: 'NotSupported' };

      case 'GetLocalListVersion':
        // OCPP 1.6 section 5.10: -1 means the Charge Point has no Local Authorization List
        // (feature profile not supported, or LocalAuthListEnabled is false).
        if (this.is16 && !this.localAuthListActive16()) return { listVersion: -1 };
        return this.is16
          ? { listVersion: this.localAuthListVersion }
          : { versionNumber: this.localAuthListVersion };

      case 'SendLocalList': {
        const updateType = (payload['updateType'] as string | undefined) ?? 'Full';
        const listVersion =
          (payload['versionNumber'] as number | undefined) ??
          (payload['listVersion'] as number | undefined) ??
          0;
        const localAuthList =
          (payload['localAuthorizationList'] as Array<Record<string, unknown>> | undefined) ?? [];

        // Validate version for Differential updates
        // VersionMismatch when new version is not higher than current
        if (updateType === 'Differential' && listVersion <= this.localAuthListVersion) {
          return { status: 'VersionMismatch' };
        }

        if (this.is16 && !this.supportsFeatureProfile16('LocalAuthListManagement')) {
          return { status: 'NotSupported' };
        }

        // List size limit: 1.6 LocalAuthListMaxLength, 100 entries for 2.1
        const maxSize = this.is16 ? this.localAuthListMaxLength16() : 100;
        const totalAfterUpdate =
          updateType === 'Full'
            ? localAuthList.length
            : this.localAuthEntries.size + localAuthList.length;
        if (totalAfterUpdate > maxSize) {
          return { status: 'Failed' };
        }

        this.localAuthListVersion = listVersion;
        if (updateType === 'Full') {
          this.localAuthEntries.clear();
          for (const entry of localAuthList) {
            const idTokenValue = this.is16
              ? (entry['idTag'] as string | undefined)
              : ((entry['idToken'] as Record<string, unknown> | undefined)?.['idToken'] as
                  | string
                  | undefined);
            if (idTokenValue != null) {
              this.storeLocalAuthEntry(idTokenValue, entry);
            }
          }
        } else {
          for (const entry of localAuthList) {
            const idTokenValue = this.is16
              ? (entry['idTag'] as string | undefined)
              : ((entry['idToken'] as Record<string, unknown> | undefined)?.['idToken'] as
                  | string
                  | undefined);
            if (idTokenValue == null) continue;
            const hasStatus = this.is16 ? entry['idTagInfo'] != null : entry['idTokenInfo'] != null;
            if (hasStatus) {
              this.storeLocalAuthEntry(idTokenValue, entry);
            } else {
              this.localAuthEntries.delete(idTokenValue);
            }
          }
        }
        console.log(
          `[${this.config.stationId}] SendLocalList ${updateType}: ${String(this.localAuthEntries.size)} entries, version ${String(listVersion)}`,
        );
        return { status: 'Accepted' };
      }

      case 'UpdateFirmware': {
        let fwLocation: string;
        if (this.is16) {
          fwLocation = payload['location'] as string;
        } else {
          const firmware = payload['firmware'] as Record<string, unknown> | undefined;
          fwLocation =
            (firmware?.['location'] as string | undefined) ?? (payload['location'] as string);
        }
        // OCPP 2.1 carries the requestId on the UpdateFirmware payload, and
        // FirmwareStatusNotification echoes it back so the CSMS can correlate
        // status updates to the originating request. Without it, the CSMS
        // creates a parallel "unknown" firmware_updates row per status and the
        // original row stays stuck at status=null.
        if (!this.is16) return this.updateFirmware21(payload);
        const fwRequestId = payload['requestId'] as number | undefined;
        void this.simulateFirmwareUpdate(fwLocation, fwRequestId).catch(() => {});
        return {};
      }

      case 'PublishFirmware':
        return { status: 'Accepted' };

      case 'UnpublishFirmware':
        return { status: 'Unpublished' };

      case 'GetLog': {
        const logRequestId = payload['requestId'] as number;
        const logObj = payload['log'] as Record<string, unknown> | undefined;
        const logLocation = (logObj?.['remoteLocation'] as string | undefined) ?? '';
        const logKind = payload['logType'] === 'SecurityLog' ? 'security' : 'diagnostics';
        const logFilename = `${logKind}-${this.config.stationId}-${String(Date.now())}.log`;

        // If there is an active upload, a second request cancels it
        if (this.activeLogUploadRequestId != null) {
          this.activeLogUploadRequestId = logRequestId;
          void this.simulateLogUpload(logRequestId, logLocation).catch(() => {});
          return { status: 'AcceptedCanceled', filename: logFilename };
        }

        this.activeLogUploadRequestId = logRequestId;
        void this.simulateLogUpload(logRequestId, logLocation).catch(() => {});
        return { status: 'Accepted', filename: logFilename };
      }

      case 'GetMonitoringReport': {
        const monReportRequestId = payload['requestId'] as number;
        const monCriteria = payload['monitoringCriteria'] as string[] | undefined;
        const monCompVar = payload['componentVariable'] as
          | Array<Record<string, unknown>>
          | undefined;

        if (!this.is16) {
          // Validate criteria values
          const validCriteria = ['ThresholdMonitoring', 'DeltaMonitoring', 'PeriodicMonitoring'];
          if (monCriteria != null && monCriteria.some((c) => !validCriteria.includes(c))) {
            return { status: 'NotSupported' };
          }

          // Filter monitors
          let matchingMonitors = Array.from(this.variableMonitors.values());

          // Filter by criteria (monitor type mapping)
          if (monCriteria != null && monCriteria.length > 0) {
            const criteriaTypeMap: Record<string, string[]> = {
              ThresholdMonitoring: ['UpperThreshold', 'LowerThreshold'],
              DeltaMonitoring: ['Delta'],
              PeriodicMonitoring: ['Periodic', 'PeriodicClockAligned'],
            };
            const allowedTypes = monCriteria.flatMap((c) => criteriaTypeMap[c] ?? []);
            matchingMonitors = matchingMonitors.filter((m) => allowedTypes.includes(m.type));
          }

          // Filter by componentVariable
          if (monCompVar != null && monCompVar.length > 0) {
            matchingMonitors = matchingMonitors.filter((m) => {
              return monCompVar.some((cv) => {
                const comp = cv['component'] as Record<string, unknown>;
                const variable = cv['variable'] as Record<string, unknown>;
                const compMatch =
                  (m.component['name'] as string) === (comp['name'] as string) &&
                  JSON.stringify(m.component['evse'] ?? null) ===
                    JSON.stringify(comp['evse'] ?? null);
                const varMatch = (m.variable['name'] as string) === (variable['name'] as string);
                return compMatch && varMatch;
              });
            });
          }

          if (matchingMonitors.length === 0) {
            return { status: 'EmptyResultSet' };
          }

          // Send report asynchronously
          const reportMonitors = matchingMonitors.map((m) => ({
            component: m.component,
            variable: m.variable,
            variableMonitoring: [
              {
                id: m.id,
                transaction: m.transaction ?? false,
                value: m.value ?? 0,
                type: m.type,
                severity: m.severity,
                eventNotificationType: monitorNotificationType(m),
              },
            ],
          }));
          setTimeout(() => {
            void this.sendNotifyMonitoringReport(monReportRequestId, reportMonitors).catch(
              () => {},
            );
          }, 200);
          return { status: 'Accepted' };
        }
        return { status: 'Accepted' };
      }

      case 'SetMonitoringBase': {
        const monBase = payload['monitoringBase'] as string;
        const validBases = ['All', 'FactoryDefault', 'HardWiredOnly'];
        if (!validBases.includes(monBase)) {
          return { status: 'NotSupported' };
        }
        if (monBase === 'HardWiredOnly') {
          // Remove all non-hardwired monitors
          for (const [id, mon] of Array.from(this.variableMonitors)) {
            if (!mon.isHardwired) {
              this.removeMonitor(id);
            }
          }
        } else if (monBase === 'FactoryDefault') {
          // Remove all non-hardwired monitors and re-seed factory defaults
          for (const [id, mon] of Array.from(this.variableMonitors)) {
            if (!mon.isHardwired) {
              this.removeMonitor(id);
            }
          }
          this.seedDefaultMonitors();
        }
        return { status: 'Accepted' };
      }

      case 'SetMonitoringLevel': {
        const monSeverity = payload['severity'] as number;
        if (monSeverity < 0 || monSeverity > 9) {
          return { status: 'Rejected' };
        }
        this.monitoringLevel = monSeverity;
        return { status: 'Accepted' };
      }

      case 'SetVariableMonitoring': {
        const setMonData = (payload['setMonitoringData'] ?? []) as Array<Record<string, unknown>>;
        return {
          setMonitoringResult: setMonData.map((item) => {
            const comp = item['component'] as Record<string, unknown>;
            const variable = item['variable'] as Record<string, unknown>;
            const monType = item['type'] as string;
            const monValue = item['value'] as number;
            const monSeverity = item['severity'] as number;

            // Validate component exists
            if (!this.isKnownComponent(comp)) {
              return {
                status: 'UnknownComponent',
                type: monType,
                severity: monSeverity,
                component: comp,
                variable,
                id: 0,
              };
            }

            // Validate variable exists on component
            if (!this.isKnownVariable(comp, variable)) {
              return {
                status: 'UnknownVariable',
                type: monType,
                severity: monSeverity,
                component: comp,
                variable,
                id: 0,
              };
            }

            // Validate value ranges
            if (monType === 'Delta' && monValue < 0) {
              return {
                status: 'Rejected',
                type: monType,
                severity: monSeverity,
                component: comp,
                variable,
                id: 0,
              };
            }
            if (
              (monType === 'UpperThreshold' || monType === 'LowerThreshold') &&
              monValue > 100000
            ) {
              return {
                status: 'Rejected',
                type: monType,
                severity: monSeverity,
                component: comp,
                variable,
                id: 0,
              };
            }

            // Threshold monitors need a numeric variable (N04: UnsupportedMonitorType)
            const currentValue = this.monitoredValue(comp, variable['name'] as string);
            if (
              (monType === 'UpperThreshold' || monType === 'LowerThreshold') &&
              currentValue != null &&
              typeof currentValue !== 'number'
            ) {
              return {
                status: 'UnsupportedMonitorType',
                type: monType,
                severity: monSeverity,
                component: comp,
                variable,
                id: 0,
              };
            }

            // Replace the monitor with the given id, or create a new one
            const requestedId = item['id'] as number | undefined;
            if (requestedId == null) {
              // N04: a monitor of the same type and severity on the variable exists
              const duplicate = Array.from(this.variableMonitors.values()).some(
                (m) =>
                  m.type === monType &&
                  m.severity === monSeverity &&
                  this.monitorMatches(m, comp, variable['name'] as string) &&
                  JSON.stringify(m.component['evse'] ?? null) ===
                    JSON.stringify(comp['evse'] ?? null),
              );
              if (duplicate) {
                return {
                  status: 'Duplicate',
                  type: monType,
                  severity: monSeverity,
                  component: comp,
                  variable,
                  id: 0,
                };
              }
            }
            if (requestedId != null) {
              const existingMon = this.variableMonitors.get(requestedId);
              // A monitor keeps its component and variable (N04: replacing changes
              // its settings only).
              const sameTarget =
                existingMon != null &&
                existingMon.component['name'] === comp['name'] &&
                JSON.stringify(existingMon.component['evse'] ?? null) ===
                  JSON.stringify(comp['evse'] ?? null) &&
                existingMon.variable['name'] === variable['name'];
              if (existingMon == null || existingMon.isHardwired || !sameTarget) {
                return {
                  status: 'Rejected',
                  type: monType,
                  severity: monSeverity,
                  component: comp,
                  variable,
                  id: requestedId,
                };
              }
            }
            const monId = requestedId ?? ++this.monitorIdCounter;
            const periodicEventStream = item['periodicEventStream'] as
              | { interval?: number; values?: number }
              | undefined;
            const monitor: VariableMonitor = {
              id: monId,
              type: monType,
              severity: monSeverity,
              component: comp,
              variable,
              isHardwired: false,
              value: monValue,
              transaction: (item['transaction'] as boolean | undefined) ?? false,
              periodicEventStream,
            };
            this.variableMonitors.set(monId, monitor);
            this.monitorExceeded.delete(monId);
            const current = this.monitoredValue(comp, variable['name'] as string);
            if (current != null) this.monitorDeltaBase.set(monId, current);
            else this.monitorDeltaBase.delete(monId);
            // Periodic monitors start reporting after the response is sent.
            setTimeout(() => {
              void this.applyPeriodicMonitor(monId).catch(() => {});
            }, 0);

            return {
              status: 'Accepted',
              type: monType,
              severity: monSeverity,
              component: comp,
              variable,
              id: monId,
            };
          }),
        };
      }

      case 'ClearVariableMonitoring': {
        const monitorIds = (payload['id'] ?? []) as number[];
        return {
          clearMonitoringResult: monitorIds.map((id) => {
            const monitor = this.variableMonitors.get(id);
            if (monitor == null) {
              return { status: 'NotFound', id };
            }
            if (monitor.isHardwired) {
              return { status: 'Rejected', id };
            }
            this.removeMonitor(id);
            return { status: 'Accepted', id };
          }),
        };
      }

      case 'SetNetworkProfile': {
        const configSlot = payload['configurationSlot'] as number | undefined;
        if (configSlot == null || configSlot < 1 || configSlot > 10) {
          return { status: 'Rejected' };
        }

        const connData = payload['connectionData'] as Record<string, unknown> | undefined;
        const newSecProfile = connData?.['securityProfile'] as number | undefined;
        const currentSecProfile = Number(
          this.configVariables.get('SecurityCtrlr.SecurityProfile')?.value ?? '0',
        );
        const allowDowngrade =
          this.configVariables.get('SecurityCtrlr.AllowSecurityDowngrade')?.value === 'true';

        // Reject security downgrade unless explicitly allowed
        if (newSecProfile != null && newSecProfile < currentSecProfile && !allowDowngrade) {
          return { status: 'Rejected' };
        }

        // Store connection data in device model
        if (connData != null) {
          const slot = String(configSlot);
          const fields: Array<[string, string | undefined]> = [
            ['OcppCsmsUrl', connData['ocppCsmsUrl'] as string | undefined],
            ['OcppInterface', connData['ocppInterface'] as string | undefined],
            ['OcppTransport', connData['ocppTransport'] as string | undefined],
            ['OcppVersion', connData['ocppVersion'] as string | undefined],
            [
              'MessageTimeout',
              typeof connData['messageTimeout'] === 'string' ||
              typeof connData['messageTimeout'] === 'number' ||
              typeof connData['messageTimeout'] === 'boolean'
                ? String(connData['messageTimeout'])
                : undefined,
            ],
            ['SecurityProfile', newSecProfile != null ? String(newSecProfile) : undefined],
            ['BasicAuthPassword', connData['basicAuthPassword'] as string | undefined],
            ['VpnEnabled', 'false'],
            ['ApnEnabled', 'false'],
          ];
          for (const [varName, value] of fields) {
            if (value != null) {
              this.configVariables.set(`NetworkConfiguration.${varName}#${slot}`, {
                value,
                readonly: false,
              });
            }
          }
        }

        return { status: 'Accepted' };
      }

      case 'ClearDisplayMessage': {
        const clearMsgId = payload['id'] as number;
        if (this.displayMessagesCache.has(clearMsgId)) {
          this.displayMessagesCache.delete(clearMsgId);
          return { status: 'Accepted' };
        }
        return { status: 'Unknown' };
      }

      case 'GetDisplayMessages': {
        const getRequestId = payload['requestId'] as number;
        const filterIds = payload['id'] as number[] | undefined;
        const filterPriority = payload['priority'] as string | undefined;
        const filterState = payload['state'] as string | undefined;

        // Use in-memory cache (DB may not have rows from current test session)
        let messages = Array.from(this.displayMessagesCache.values());

        if (filterIds != null) {
          const idSet = new Set(filterIds);
          messages = messages.filter((m) => idSet.has(m['id'] as number));
        }
        if (filterPriority != null) {
          messages = messages.filter((m) => m['priority'] === filterPriority);
        }
        if (filterState != null) {
          messages = messages.filter((m) => m['state'] === filterState);
        }

        if (messages.length > 0) {
          void this.sendNotifyDisplayMessages(getRequestId, messages).catch(() => {});
        }

        return { status: messages.length > 0 ? 'Accepted' : 'Unknown' };
      }

      case 'SetDisplayMessage': {
        const msgInfo = payload['message'] as Record<string, unknown>;
        const msgId = msgInfo['id'] as number;
        const msgPriority = msgInfo['priority'] as string | undefined;
        const msgState = msgInfo['state'] as string | undefined;
        const msgTransactionId = msgInfo['transactionId'] as string | undefined;

        // Validate priority, state, message formats, and languages against
        // DisplayMessageCtrlr (O01: NotSupportedPriority, NotSupportedState,
        // NotSupportedMessageFormat, LanguageNotSupported).
        const memberList = (key: string, fallback: string): string[] =>
          (this.getConfigValue(`DisplayMessageCtrlr.${key}`) ?? fallback)
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v !== '');
        const supportedPriorities = memberList(
          'SupportedPriorities',
          'AlwaysFront,InFront,NormalCycle',
        );
        if (msgPriority != null && !supportedPriorities.includes(msgPriority)) {
          return { status: 'NotSupportedPriority' };
        }

        const supportedStates = memberList('SupportedStates', 'Charging,Faulted,Idle,Unavailable');
        if (msgState != null && !supportedStates.includes(msgState)) {
          return { status: 'NotSupportedState' };
        }

        const contents = [
          msgInfo['message'] as Record<string, unknown> | undefined,
          ...((msgInfo['messageExtra'] ?? []) as Array<Record<string, unknown>>),
        ].filter((c): c is Record<string, unknown> => c != null);
        const supportedFormats = memberList('SupportedFormats', 'ASCII,UTF8');
        if (contents.some((c) => !supportedFormats.includes(c['format'] as string))) {
          return { status: 'NotSupportedMessageFormat' };
        }
        if (
          contents.some(
            (c) =>
              c['language'] != null &&
              !DISPLAY_LANGUAGES.includes((c['language'] as string).toLowerCase()),
          )
        ) {
          return { status: 'LanguageNotSupported' };
        }

        // Validate transactionId if provided: check if any transaction is active
        if (msgTransactionId != null) {
          let anyTxActive = false;
          for (const evse of this.config.evses) {
            const tx = await this.getActiveTransaction(evse.evseId);
            if (tx != null) {
              anyTxActive = true;
              break;
            }
          }
          if (!anyTxActive) {
            return { status: 'UnknownTransaction' };
          }
        }

        // Only one AlwaysFront message is shown: a new one replaces the previous
        // AlwaysFront message of the same scope (the same transaction, or none).
        if (msgPriority === 'AlwaysFront') {
          for (const [existingId, existingMsg] of Array.from(this.displayMessagesCache)) {
            if (
              existingId !== msgId &&
              existingMsg['priority'] === 'AlwaysFront' &&
              existingMsg['transactionId'] === msgTransactionId
            ) {
              this.displayMessagesCache.delete(existingId);
            }
          }
        }

        this.displayMessagesCache.set(msgId, msgInfo);

        return { status: 'Accepted' };
      }

      case 'CostUpdated': {
        // E16.FR.11/15: the running cost from CSMS when it calculates the cost
        if (!this.is16) {
          const costTxId = payload['transactionId'] as string;
          const costEvseId = await this.findEvseForTransaction(costTxId);
          if (costEvseId != null) {
            this.evseTotalCost.set(costEvseId, payload['totalCost'] as number);
            setTimeout(() => {
              void this.checkCentralCostLimit(costEvseId, costTxId).catch(() => {});
            }, 0);
          }
        }
        return {};
      }

      case 'NotifyWebPaymentStarted':
        // C25.FR.27: respond without parameters
        console.log(
          `[${this.config.stationId}] Web payment started on EVSE ${String(payload['evseId'])} (timeout ${String(payload['timeout'])} s)`,
        );
        return {};

      case 'CustomerInformation': {
        const custRequestId = payload['requestId'] as number;
        const custReport = payload['report'] as boolean;
        const custClear = payload['clear'] as boolean;
        const custIdToken = payload['idToken'] as Record<string, unknown> | undefined;
        const custIdentifier = payload['customerIdentifier'] as string | undefined;
        const custCert = payload['customerCertificate'] as Record<string, unknown> | undefined;

        // Must have at least one of idToken, customerIdentifier, or customerCertificate
        if (custIdToken == null && custIdentifier == null && custCert == null) {
          return { status: 'Invalid' };
        }

        if (!this.is16) {
          // Determine the lookup key
          let custKey: string | null = null;
          if (custIdToken != null) {
            custKey = custIdToken['idToken'] as string;
          } else if (custIdentifier != null) {
            custKey = custIdentifier;
          } else if (custCert != null) {
            const serialNum = custCert['serialNumber'] as string | undefined;
            custKey = `cert:${serialNum ?? 'unknown'}`;
          }

          const custData = custKey != null ? (this.customerDataStore.get(custKey) ?? '') : '';

          if (custReport) {
            setTimeout(() => {
              void this.sendNotifyCustomerInformation(custRequestId, custData).catch(() => {});
            }, 200);
          }

          // Clear customer data if requested
          if (custClear && custKey != null) {
            this.customerDataStore.delete(custKey);
          }
        }
        return { status: 'Accepted' };
      }

      case 'GetTransactionStatus': {
        const txIdQuery = payload['transactionId'] as string | undefined;
        if (txIdQuery != null) {
          // Look up whether this specific transaction is ongoing (E14.FR.01-03)
          let ongoing = false;
          for (const [, id] of this.activeTransactionIds) {
            if (id === txIdQuery) {
              ongoing = true;
              break;
            }
          }
          // E14.FR.04/05: queued messages about this transaction
          return {
            messagesInQueue: this.hasQueuedTransactionMessages(txIdQuery),
            ongoingIndicator: ongoing,
          };
        }
        // E14.FR.06-08: no transactionId, omit ongoingIndicator, report any queued
        // transaction-related message
        return { messagesInQueue: this.hasQueuedTransactionMessages() };
      }

      case 'DataTransfer':
        // Unknown vendor/message: return UnknownVendorId per OCPP spec
        return { status: 'UnknownVendorId' };

      case 'SetDefaultTariff': {
        if (this.is16) return { status: 'Rejected' };
        const sdt_evseId = payload['evseId'] as number;
        const sdt_tariff = payload['tariff'] as Record<string, unknown>;
        const sdt_tariffId = sdt_tariff['tariffId'] as string;
        if (sdt_evseId !== 0 && !this.config.evses.some((e) => e.evseId === sdt_evseId)) {
          return { status: 'Rejected', statusInfo: { reasonCode: 'UnknownEVSE' } };
        }
        const sections = TARIFF_PRICE_SECTIONS.map(
          (key) => sdt_tariff[key] as Record<string, unknown> | undefined,
        ).filter((section): section is Record<string, unknown> => section != null);
        if (
          !['energy', 'chargingTime', 'idleTime', 'fixedFee'].some((k) => sdt_tariff[k] != null)
        ) {
          return { status: 'Rejected', statusInfo: { reasonCode: 'InvalidValue' } };
        }
        // TariffCostCtrlr.MaxElements[Tariff]: price elements per tariff section
        const sdt_maxElements = Number(
          this.getConfigValue('TariffCostCtrlr.MaxElements#Tariff') ?? '10',
        );
        if (
          sections.some(
            (section) => ((section['prices'] ?? []) as unknown[]).length > sdt_maxElements,
          )
        ) {
          return { status: 'TooManyElements' };
        }
        // TariffCostCtrlr.ConditionsSupported[Tariff] is false
        if (
          sections.some((section) =>
            ((section['prices'] ?? []) as Array<Record<string, unknown>>).some(
              (price) => price['conditions'] != null,
            ),
          )
        ) {
          return { status: 'ConditionNotSupported' };
        }
        if (this.defaultTariffs.has(sdt_tariffId)) {
          return { status: 'DuplicateTariffId' };
        }
        // A default tariff replaces the previous default tariff of the same EVSE
        // (EVSE 0: the whole station) with the same validFrom; tariffs that
        // become valid later stay scheduled next to it.
        const sdt_validFrom = sdt_tariff['validFrom'] ?? null;
        for (const [tid, entry] of Array.from(this.defaultTariffs)) {
          if (
            entry.evseId === sdt_evseId &&
            (entry.tariff['validFrom'] ?? null) === sdt_validFrom &&
            !entry.inUse
          ) {
            this.defaultTariffs.delete(tid);
          }
        }
        this.defaultTariffs.set(sdt_tariffId, {
          evseId: sdt_evseId,
          tariff: sdt_tariff,
          inUse: false,
        });
        return { status: 'Accepted' };
      }

      case 'GetTariffs': {
        if (this.is16) return { status: 'Rejected' };
        const gt_evseId = payload['evseId'] as number | undefined;
        const assignments: Array<Record<string, unknown>> = [];
        for (const [tariffId, entry] of this.defaultTariffs) {
          // The EVSEs the tariff applies to: a station-wide (EVSE 0) tariff
          // covers the EVSEs without their own default tariff.
          const evseIds =
            entry.evseId === 0
              ? this.config.evses
                  .map((e) => e.evseId)
                  .filter(
                    (id) => !Array.from(this.defaultTariffs.values()).some((t) => t.evseId === id),
                  )
              : [entry.evseId];
          if (evseIds.length === 0) continue;
          if (gt_evseId != null && gt_evseId !== 0 && !evseIds.includes(gt_evseId)) continue;
          assignments.push({ tariffId, tariffKind: 'DefaultTariff', evseIds });
        }
        // Include driver tariffs
        for (const [evse, dt] of this.driverTariffs) {
          if (gt_evseId != null && evse !== gt_evseId && evse !== 0) continue;
          assignments.push({
            tariffId: dt.tariffId,
            tariffKind: 'DriverTariff',
            evseIds: evse === 0 ? this.config.evses.map((e) => e.evseId) : [evse],
          });
        }
        if (assignments.length === 0) {
          return { status: 'NoTariff' };
        }
        // Return most recently added tariff first (last inserted = most recent)
        assignments.reverse();
        return { status: 'Accepted', tariffAssignments: assignments };
      }

      case 'ClearTariffs': {
        if (this.is16) return { clearTariffsResult: [{ status: 'Rejected' }] };
        const ct_tariffIds = payload['tariffIds'] as string[] | undefined;
        const ct_results: Array<Record<string, unknown>> = [];
        if (ct_tariffIds != null && ct_tariffIds.length > 0) {
          // Clear specific tariffs
          for (const tid of ct_tariffIds) {
            const entry = this.defaultTariffs.get(tid);
            if (entry != null) {
              // If tariff is in use, mark for clearing but keep in store
              if (entry.inUse) {
                // Keep the tariff but mark it as cleared (will be removed after tx ends)
                ct_results.push({ tariffId: tid, status: 'Accepted' });
              } else {
                this.defaultTariffs.delete(tid);
                ct_results.push({ tariffId: tid, status: 'Accepted' });
              }
            } else {
              ct_results.push({ tariffId: tid, status: 'Unknown' });
            }
          }
        } else {
          // Clear all tariffs
          for (const [tid, entry] of this.defaultTariffs) {
            ct_results.push({ tariffId: tid, status: 'Accepted' });
            if (!entry.inUse) {
              this.defaultTariffs.delete(tid);
            }
          }
        }
        return { clearTariffsResult: ct_results };
      }

      case 'UsePriorityCharging':
        return { status: 'Accepted' };

      case 'UpdateDynamicSchedule':
        return { status: 'Accepted' };

      case 'ChangeTransactionTariff': {
        if (this.is16) return { status: 'Rejected' };
        // If local cost calculation is not supported, return CALLERROR NotSupported
        const ctt_localCostSupported =
          this.getConfigValue('TariffCostCtrlr.LocalCostSupported') ?? 'true';
        if (ctt_localCostSupported !== 'true') {
          throw new Error('NotSupported');
        }
        const ctt_txId = payload['transactionId'] as string;
        const ctt_tariff = payload['tariff'] as Record<string, unknown>;
        const ctt_tariffId = ctt_tariff['tariffId'] as string;
        const ctt_currency = ctt_tariff['currency'] as string;

        // Check if transaction exists
        const ctt_evseId = await this.findEvseForTransaction(ctt_txId);
        if (ctt_evseId == null) {
          // Also check in-memory transaction IDs
          let found = false;
          for (const [, txId] of this.activeTransactionIds) {
            if (txId === ctt_txId) {
              found = true;
              break;
            }
          }
          if (!found) return { status: 'TxNotFound' };
        }

        // Check TariffMaxElements: count total price elements
        const ctt_maxElements = Number(
          this.configVariables.get('TariffCostCtrlr.MaxElements#Tariff')?.value ?? '10',
        );
        let ctt_elementCount = 0;
        for (const key of [
          'energy',
          'chargingTime',
          'idleTime',
          'fixedFee',
          'reservationTime',
          'reservationFixed',
        ]) {
          const section = ctt_tariff[key] as Record<string, unknown> | undefined;
          if (section != null) {
            const prices = section['prices'] as Array<unknown> | undefined;
            if (prices != null) ctt_elementCount += prices.length;
          }
        }
        if (ctt_elementCount > ctt_maxElements) {
          return { status: 'TooManyElements' };
        }

        // Check ConditionNotSupported: if any price element has complex conditions
        // we report ConditionNotSupported (simplified check -- our simulator does not support conditions)
        let ctt_hasConditions = false;
        for (const key of [
          'energy',
          'chargingTime',
          'idleTime',
          'fixedFee',
          'reservationTime',
          'reservationFixed',
        ]) {
          const section = ctt_tariff[key] as Record<string, unknown> | undefined;
          if (section != null) {
            const prices = (section['prices'] ?? []) as Array<Record<string, unknown>>;
            for (const p of prices) {
              const cond = p['conditions'] as Record<string, unknown> | undefined;
              if (cond != null) {
                // Check for conditions beyond simple time-of-day
                const condKeys = Object.keys(cond);
                const complexKeys = condKeys.filter(
                  (k) => k !== 'startTimeOfDay' && k !== 'endTimeOfDay' && k !== 'evseKind',
                );
                if (complexKeys.length > 0) {
                  ctt_hasConditions = true;
                  break;
                }
              }
            }
          }
          if (ctt_hasConditions) break;
        }
        if (ctt_hasConditions) {
          return { status: 'ConditionNotSupported' };
        }

        // Check currency change
        const ctt_existingCurrency = this.transactionTariffCurrency.get(ctt_txId);
        if (ctt_existingCurrency != null && ctt_existingCurrency !== ctt_currency) {
          return { status: 'NoCurrencyChange' };
        }

        // Accept and store
        this.transactionTariffCurrency.set(ctt_txId, ctt_currency);

        // Send TariffChanged TransactionEvent
        const ctt_evse = ctt_evseId ?? 1;
        setTimeout(() => {
          void this.client
            .sendCall('TransactionEvent', {
              eventType: 'Updated',
              timestamp: new Date().toISOString(),
              triggerReason: 'TariffChanged',
              seqNo: (this.evseSeqNo.get(ctt_evse) ?? 0) + 1,
              transactionInfo: {
                transactionId: ctt_txId,
                tariffId: ctt_tariffId,
              },
            })
            .catch(() => {});
        }, 200);

        return { status: 'Accepted' };
      }

      case 'AFRRSignal':
        return { status: 'Accepted' };

      case 'AdjustPeriodicEventStream': {
        // N15: change the transmission parameters of an open stream
        const adjustId = payload['id'] as number;
        const params = (payload['params'] ?? {}) as { interval?: number; values?: number };
        const stream = Array.from(this.periodicStreams.values()).find((st) => st.id === adjustId);
        if (stream == null) {
          return { status: 'Rejected', statusInfo: { reasonCode: 'UnknownStream' } };
        }
        if (params.interval != null) stream.interval = params.interval;
        if (params.values != null) stream.values = params.values;
        this.scheduleStreamFlush(stream);
        return { status: 'Accepted' };
      }

      case 'ClosePeriodicEventStream':
        return {};

      case 'OpenPeriodicEventStream':
        return { status: 'Accepted' };

      case 'GetPeriodicEventStream': {
        // N14: the open periodic event streams
        const streams = Array.from(this.periodicStreams.values()).map((st) => ({
          id: st.id,
          variableMonitoringId: st.monitorId,
          params: { interval: st.interval, values: st.values },
        }));
        return streams.length > 0 ? { constantStreamData: streams } : {};
      }

      case 'ClearDERControl':
        return { status: 'Accepted' };

      case 'GetDERControl':
        return { status: 'Accepted' };

      case 'SetDERControl':
        return { status: 'Accepted' };

      case 'RequestBatterySwap':
        return { status: 'Accepted' };

      case 'VatNumberValidation':
        return {
          status: 'Accepted',
          vatNumber: payload['vatNumber'] as string,
          evseId: payload['evseId'] ?? 1,
          company: {
            name: 'Simulated Company B.V.',
            address1: '123 Charging Street',
            city: 'Amsterdam',
            country: 'Netherlands',
          },
        };

      case 'GetDiagnostics': {
        const diagLocation = payload['location'] as string;
        void this.simulateDiagnosticsUpload(diagLocation).catch(() => {});
        return { fileName: 'diagnostics.txt' };
      }

      default:
        // OCPP-J: an action the station does not implement is answered with CALLERROR NotImplemented.
        console.log(`[${this.config.stationId}] Unhandled action: ${action}`);
        throw new Error('NotImplemented');
    }
  }

  // ---------------------------------------------------------------------------
  // OCPP 1.6 Security Whitepaper: certificate store, certificate renewal,
  // security log, and signed firmware update
  // ---------------------------------------------------------------------------

  // OCPP 1.6 SupportedFeatureProfiles (read-only, set at the factory).
  private supportsFeatureProfile16(profile: string): boolean {
    return (this.getConfigValue('SupportedFeatureProfiles') ?? '')
      .split(',')
      .map((p) => p.trim())
      .includes(profile);
  }

  private localAuthListActive16(): boolean {
    return (
      this.supportsFeatureProfile16('LocalAuthListManagement') &&
      this.getConfigValue('LocalAuthListEnabled') !== 'false'
    );
  }

  // Entries the Local Authorization List can hold (LocalAuthListMaxLength, 0 = no storage).
  private localAuthListMaxLength16(): number {
    const max = Number(this.getConfigValue('LocalAuthListMaxLength'));
    return Number.isInteger(max) && max >= 0 ? max : 100;
  }

  private configInt16(key: string, fallback: number): number {
    const value = Number(this.getConfigValue(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  // Certificates of a type in the store, parsed from their PEM.
  private storedCertificates(type: string): X509Certificate[] {
    const certs: X509Certificate[] = [];
    for (const entry of this.installedCertificatesCache.values()) {
      if (entry.certificateType !== type || entry.certificate == null) continue;
      const parsed = parseCertificateChain(entry.certificate)?.[0];
      if (parsed != null) certs.push(parsed);
    }
    return certs;
  }

  // The Central System root certificates the station trusts: the installed ones
  // and the CA it was provisioned with for its TLS connection.
  private centralSystemRoots16(): X509Certificate[] {
    const provisioned =
      this.config.caCert != null ? (parseCertificateChain(this.config.caCert) ?? []) : [];
    return [...this.storedCertificates('CentralSystemRootCertificate'), ...provisioned];
  }

  // Factory state of a 1.6 station: the CA it was provisioned with is its
  // CentralSystemRootCertificate.
  private seedCertificates16(): void {
    if (this.config.caCert == null) return;
    for (const cert of parseCertificateChain(this.config.caCert) ?? []) {
      if (!isSelfSigned(cert) || !isCaCertificate(cert)) continue;
      const hashData = certificateHashData(cert, cert);
      this.installedCertificatesCache.set(hashData.serialNumber, {
        certificateType: 'CentralSystemRootCertificate',
        certificateHashData: { ...hashData },
        certificate: cert.toString(),
      });
    }
  }

  private installCertificate16(payload: Record<string, unknown>): Record<string, unknown> {
    const certificateType = payload['certificateType'] as string;
    if (
      certificateType !== 'CentralSystemRootCertificate' &&
      certificateType !== 'ManufacturerRootCertificate'
    ) {
      return { status: 'Rejected' };
    }
    const cert = parseCertificateChain((payload['certificate'] as string | undefined) ?? '')?.[0];
    // Both types are CA certificates that anchor a chain.
    if (cert == null || !isWithinValidity(cert) || !isCaCertificate(cert)) {
      return { status: 'Rejected' };
    }

    // A root certificate signs itself; otherwise its issuer must already be in the store.
    const issuer = isSelfSigned(cert)
      ? cert
      : this.storedCertificates(certificateType).find(
          (c) => isCaCertificate(c) && isIssuedBy(cert, c),
        );
    if (issuer == null) return { status: 'Rejected' };

    const hashData = certificateHashData(cert, issuer);
    const alreadyInstalled = [...this.installedCertificatesCache.values()].some(
      (entry) =>
        entry.certificateType === certificateType &&
        sameCertificateHashData(entry.certificateHashData, { ...hashData }),
    );
    if (!alreadyInstalled) {
      if (
        this.installedCertificatesCache.size >= this.configInt16('CertificateStoreMaxLength', 10)
      ) {
        return { status: 'Failed' };
      }
      this.installedCertificatesCache.set(hashData.serialNumber, {
        certificateType,
        certificateHashData: { ...hashData },
        certificate: cert.toString(),
      });
    }
    console.log(
      `[${this.config.stationId}] InstallCertificate: ${certificateType} (${hashData.serialNumber})`,
    );
    return { status: 'Accepted' };
  }

  private getInstalledCertificateIds16(payload: Record<string, unknown>): Record<string, unknown> {
    const certificateType = payload['certificateType'] as string;
    const certificateHashData = [...this.installedCertificatesCache.values()]
      .filter((entry) => entry.certificateType === certificateType)
      .map((entry) => ({ ...entry.certificateHashData }));
    if (certificateHashData.length === 0) return { status: 'NotFound' };
    return { status: 'Accepted', certificateHashData };
  }

  private deleteCertificate16(payload: Record<string, unknown>): Record<string, unknown> {
    const requested = payload['certificateHashData'] as Record<string, unknown> | undefined;
    const hashAlgorithm = requested?.['hashAlgorithm'];
    if (requested == null || !isCertificateHashAlgorithm(hashAlgorithm)) {
      return { status: 'NotFound' };
    }
    const provisioned =
      this.config.caCert != null ? (parseCertificateChain(this.config.caCert) ?? []) : [];
    for (const [key, entry] of this.installedCertificatesCache) {
      if (
        entry.certificateType !== 'CentralSystemRootCertificate' &&
        entry.certificateType !== 'ManufacturerRootCertificate'
      ) {
        continue;
      }
      const cert = entry.certificate != null ? parseCertificateChain(entry.certificate)?.[0] : null;
      if (cert == null) continue;
      const issuer = isSelfSigned(cert)
        ? cert
        : this.storedCertificates(entry.certificateType).find((c) => isIssuedBy(cert, c));
      if (issuer == null) continue;
      if (
        !sameCertificateHashData({ ...certificateHashData(cert, issuer, hashAlgorithm) }, requested)
      ) {
        continue;
      }
      // The root the current TLS connection relies on cannot be removed.
      if (provisioned.some((p) => p.raw.equals(cert.raw))) return { status: 'Failed' };
      this.installedCertificatesCache.delete(key);
      console.log(`[${this.config.stationId}] DeleteCertificate: removed ${key}`);
      return { status: 'Accepted' };
    }
    return { status: 'NotFound' };
  }

  private extendedTriggerMessage16(payload: Record<string, unknown>): Record<string, unknown> {
    const requestedMessage = payload['requestedMessage'] as string;
    const connectorId = payload['connectorId'] as number | undefined;
    const supported = [
      'BootNotification',
      'LogStatusNotification',
      'FirmwareStatusNotification',
      'Heartbeat',
      'MeterValues',
      'SignChargePointCertificate',
      'StatusNotification',
    ];
    if (!supported.includes(requestedMessage)) return { status: 'NotImplemented' };
    if (
      connectorId != null &&
      connectorId > 0 &&
      !this.config.evses.some((e) => e.evseId === connectorId)
    ) {
      return { status: 'Rejected' };
    }
    setTimeout(() => {
      void (async () => {
        try {
          if (requestedMessage === 'SignChargePointCertificate') {
            await this.requestChargePointCertificate16();
          } else if (requestedMessage === 'LogStatusNotification') {
            await this.sendLogStatusNotification(
              this.logUploadStatus,
              this.activeLogUploadRequestId ?? undefined,
            );
          } else {
            await this.handleTriggerMessage(requestedMessage, payload);
          }
        } catch (err) {
          console.warn(
            `[${this.config.stationId}] ExtendedTriggerMessage ${requestedMessage} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }, 100);
    return { status: 'Accepted' };
  }

  // New key pair and CSR: CN is the serial number, O the CpoName.
  private async requestChargePointCertificate16(): Promise<void> {
    const { csrPem, privateKeyPem } = await generateKeyPairAndCsr({
      commonName: this.config.serialNumber,
      organizationName: this.getConfigValue('CpoName') ?? this.config.vendorName,
    });
    this.pendingChargePointKey16 = privateKeyPem;
    const response = await this.client.sendCall('SignCertificate', { csr: csrPem });
    if (response['status'] !== 'Accepted') this.pendingChargePointKey16 = null;
  }

  private certificateSigned16(payload: Record<string, unknown>): Record<string, unknown> {
    const chainPem = (payload['certificateChain'] as string | undefined) ?? '';
    const chain = parseCertificateChain(chainPem);
    const privateKey = this.pendingChargePointKey16;
    const leaf = chain?.[0];
    const valid =
      privateKey != null &&
      chain != null &&
      leaf != null &&
      chainPem.length <= this.configInt16('CertificateSignedMaxChainSize', 10000) &&
      certificateMatchesPrivateKey(leaf, privateKey) &&
      chainsToTrustedRoot(chain, this.centralSystemRoots16());
    if (!valid) {
      void this.sendSecurityEventNotification(
        'InvalidChargePointCertificate',
        undefined,
        'CertificateSigned.req certificate chain failed validation',
      ).catch(() => {});
      return { status: 'Rejected' };
    }

    // The new certificate replaces the old one from the next connection.
    this.pendingChargePointKey16 = null;
    this.config.clientCert = chainPem;
    this.config.clientKey = privateKey;
    this.client.updateConnection({ clientCert: chainPem, clientKey: privateKey });
    void this.persistClientCertificate();
    if (this.client.connection.securityProfile === 3) {
      setTimeout(() => {
        if (!this.destroyed) this.client.simulateConnectionLoss();
      }, 2000);
    }
    return { status: 'Accepted' };
  }

  private async persistClientCertificate(): Promise<void> {
    try {
      await this.sql`
        UPDATE css_stations
        SET client_cert = ${this.config.clientCert ?? null},
            client_key = ${this.config.clientKey ?? null},
            updated_at = now()
        WHERE id = ${this.config.id}
      `;
    } catch (err) {
      console.warn(
        `[${this.config.stationId}] Failed to save the client certificate: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private signedUpdateFirmware16(payload: Record<string, unknown>): Record<string, unknown> {
    const requestId = payload['requestId'] as number;
    const firmware = payload['firmware'] as Record<string, unknown>;
    const signingChain = parseCertificateChain(
      (firmware['signingCertificate'] as string | undefined) ?? '',
    );
    const signingCert = signingChain?.[0];
    if (
      signingChain == null ||
      signingCert == null ||
      !chainsToTrustedRoot(signingChain, this.storedCertificates('ManufacturerRootCertificate'))
    ) {
      void this.sendSecurityEventNotification(
        'InvalidFirmwareSigningCertificate',
        undefined,
        'Firmware signing certificate does not chain to a ManufacturerRootCertificate',
      ).catch(() => {});
      return { status: 'InvalidCertificate' };
    }
    const canceled = this.activeSignedFirmwareRequestId != null;
    this.activeSignedFirmwareRequestId = requestId;
    void this.runSignedFirmwareUpdate16(requestId, firmware, signingCert, payload).catch(
      (err: unknown) => {
        console.warn(
          `[${this.config.stationId}] Signed firmware update ${String(requestId)} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
    return { status: canceled ? 'AcceptedCanceled' : 'Accepted' };
  }

  async sendSignedFirmwareStatusNotification(status: string, requestId?: number): Promise<void> {
    this.firmwareUpdateStatus = status;
    const payload: Record<string, unknown> = { status };
    if (requestId != null) payload['requestId'] = requestId;
    await this.client.sendCall('SignedFirmwareStatusNotification', payload);
  }

  private async downloadFirmware16(
    location: string,
    retries: number,
    retryIntervalSec: number,
  ): Promise<Buffer | null> {
    const url = URL.parse(location);
    if (url == null) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryIntervalSec * 1000));
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (response.ok) return Buffer.from(await response.arrayBuffer());
      } catch (err) {
        logger.warn(
          { err, stationId: this.config.stationId, location, attempt },
          'Firmware download failed',
        );
      }
    }
    return null;
  }

  private async runSignedFirmwareUpdate16(
    requestId: number,
    firmware: Record<string, unknown>,
    signingCert: X509Certificate,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const current = (): boolean =>
      !this.destroyed && this.activeSignedFirmwareRequestId === requestId;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const finish = (): void => {
      if (this.activeSignedFirmwareRequestId === requestId) {
        this.activeSignedFirmwareRequestId = null;
        this.firmwareUpdateStatus = 'Idle';
      }
    };

    const retrieveAt = Date.parse((firmware['retrieveDateTime'] as string | undefined) ?? '');
    if (Number.isFinite(retrieveAt) && retrieveAt > Date.now()) {
      await this.sendSignedFirmwareStatusNotification('DownloadScheduled', requestId);
      await wait(retrieveAt - Date.now());
    }
    if (!current()) return;

    await this.sendSignedFirmwareStatusNotification('Downloading', requestId);
    const image = await this.downloadFirmware16(
      firmware['location'] as string,
      (payload['retries'] as number | undefined) ?? 0,
      (payload['retryInterval'] as number | undefined) ?? 0,
    );
    if (!current()) return;
    if (image == null) {
      await this.sendSignedFirmwareStatusNotification('DownloadFailed', requestId);
      finish();
      return;
    }
    await this.sendSignedFirmwareStatusNotification('Downloaded', requestId);

    if (!verifySignature(image, (firmware['signature'] as string | undefined) ?? '', signingCert)) {
      await this.sendSignedFirmwareStatusNotification('InvalidSignature', requestId);
      await this.sendSecurityEventNotification(
        'InvalidFirmwareSignature',
        undefined,
        'Firmware signature does not match the signing certificate',
      );
      finish();
      return;
    }
    await this.sendSignedFirmwareStatusNotification('SignatureVerified', requestId);

    const installAt = Date.parse((firmware['installDateTime'] as string | undefined) ?? '');
    if (Number.isFinite(installAt) && installAt > Date.now()) {
      await this.sendSignedFirmwareStatusNotification('InstallScheduled', requestId);
      await wait(installAt - Date.now());
    }
    if (!current()) return;

    await this.sendSignedFirmwareStatusNotification('Installing', requestId);
    await wait(500);
    if (!current()) return;
    // The new firmware runs after a reboot: boot, report the connectors, then
    // log the update and report the result.
    await this.rebootStation();
    await this.sendSecurityEventNotification('FirmwareUpdated');
    await this.sendSignedFirmwareStatusNotification('Installed', requestId);
    finish();
  }

  // ---------------------------------------------------------------------------
  // OCPP 2.1 secure firmware update (L01)
  // ---------------------------------------------------------------------------

  /** ManufacturerRootCertificates the 2.1 station trusts for firmware signing certificates. */
  private manufacturerRoots(): X509Certificate[] {
    return this.storedCertificates('ManufacturerRootCertificate');
  }

  /**
   * L01 UpdateFirmware: the signing certificate must chain to an installed
   * ManufacturerRootCertificate and be valid (L01.FR.02), the firmware carries
   * a signature (secure firmware update only). A request while an update has
   * not started installing cancels it (AcceptedCanceled, L01.FR.24); once it
   * is installing a new request is Rejected.
   */
  private updateFirmware21(payload: Record<string, unknown>): Record<string, unknown> {
    const requestId = payload['requestId'] as number;
    const firmware = (payload['firmware'] ?? {}) as Record<string, unknown>;
    const signingPem = firmware['signingCertificate'] as string | undefined;
    const signature = firmware['signature'] as string | undefined;
    if (signingPem == null || signature == null) {
      return { status: 'Rejected', statusInfo: { reasonCode: 'MissingParam' } };
    }
    const signingChain = parseCertificateChain(signingPem);
    const signingCert = signingChain?.[0];
    if (
      signingChain == null ||
      signingCert == null ||
      !chainsToTrustedRoot(signingChain, this.manufacturerRoots())
    ) {
      void this.sendSecurityEventNotification(
        'InvalidFirmwareSigningCertificate',
        undefined,
        'Firmware signing certificate is not valid or does not chain to a ManufacturerRootCertificate',
      ).catch(() => {});
      return { status: 'InvalidCertificate' };
    }
    const running = this.activeFirmwareUpdate21;
    if (running != null && running.installing) {
      return { status: 'Rejected', statusInfo: { reasonCode: 'TxInProgress' } };
    }
    const update = { requestId, installing: false };
    this.activeFirmwareUpdate21 = update;
    void this.runFirmwareUpdate21(update, firmware, signingCert, payload).catch((err: unknown) => {
      console.warn(
        `[${this.config.stationId}] Firmware update ${String(requestId)} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return { status: running != null ? 'AcceptedCanceled' : 'Accepted' };
  }

  /** Waits until `until` (ms epoch) or until the update is no longer current. */
  private async waitWhileCurrent(until: () => boolean, current: () => boolean): Promise<void> {
    while (current() && !until()) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private hasOngoingTransaction(): boolean {
    return this.config.evses.some((e) => this.evseContexts.get(e.evseId)?.transactionId != null);
  }

  private async runFirmwareUpdate21(
    update: { requestId: number; installing: boolean },
    firmware: Record<string, unknown>,
    signingCert: X509Certificate,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { requestId } = update;
    const current = (): boolean => !this.destroyed && this.activeFirmwareUpdate21 === update;
    const status = async (s: string): Promise<void> => {
      this.firmwareUpdateStatus = s;
      await this.sendFirmwareStatusNotification(s, requestId);
    };
    const finish = (): void => {
      if (this.activeFirmwareUpdate21 === update) {
        this.activeFirmwareUpdate21 = null;
        this.firmwareUpdateStatus = 'Idle';
      }
    };

    const retrieveAt = Date.parse((firmware['retrieveDateTime'] as string | undefined) ?? '');
    if (Number.isFinite(retrieveAt) && retrieveAt > Date.now()) {
      await status('DownloadScheduled');
      await this.waitWhileCurrent(() => Date.now() >= retrieveAt, current);
    }
    if (!current()) return;

    await status('Downloading');
    const image = await this.downloadFirmware16(
      firmware['location'] as string,
      (payload['retries'] as number | undefined) ?? 0,
      (payload['retryInterval'] as number | undefined) ?? 0,
    );
    if (!current()) return;
    if (image == null) {
      await status('DownloadFailed');
      finish();
      return;
    }
    await status('Downloaded');

    if (!verifySignature(image, (firmware['signature'] as string | undefined) ?? '', signingCert)) {
      await status('InvalidSignature');
      await this.sendSecurityEventNotification(
        'InvalidFirmwareSignature',
        undefined,
        'Firmware signature does not match the signing certificate',
      );
      finish();
      return;
    }
    await status('SignatureVerified');

    // Installation waits for installDateTime (L01.FR.15) and, because the
    // simulator does not install with ongoing transactions (PICS C-43), for
    // the transactions to end (L01.FR.06/07).
    const installAt = Date.parse((firmware['installDateTime'] as string | undefined) ?? '');
    const installDue = (): boolean =>
      (!Number.isFinite(installAt) || Date.now() >= installAt) && !this.hasOngoingTransaction();
    const blockedConnectors: number[] = [];
    if (!installDue()) {
      await status('InstallScheduled');
      // AllowNewSessionsPendingFirmwareUpdate false: idle connectors become
      // Unavailable until the firmware is installed.
      const allowNew =
        this.getConfigValue('ChargingStation.AllowNewSessionsPendingFirmwareUpdate') !== 'false';
      if (!allowNew && this.hasOngoingTransaction()) {
        for (const evse of this.config.evses) {
          if (this.evseContexts.get(evse.evseId)?.transactionId != null) continue;
          if ((this.evseConnectorStatus.get(evse.evseId) ?? 'Available') !== 'Available') continue;
          this.evseConnectorStatus.set(evse.evseId, 'Unavailable');
          this.firmwareBlockedEvses.add(evse.evseId);
          blockedConnectors.push(evse.evseId);
          await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Unavailable').catch(
            () => {},
          );
        }
      }
      await this.waitWhileCurrent(installDue, current);
    }
    if (!current()) return;

    update.installing = true;
    await status('Installing');
    await new Promise((r) => setTimeout(r, 500));
    const installed = parseFirmwareImage(image);
    if (installed == null) {
      // The image fails the installation verification: keep the running firmware.
      await status('InstallVerificationFailed');
      await this.releaseFirmwareBlockedConnectors();
      finish();
      return;
    }
    // The new firmware runs after a reboot: boot, report the connectors, then
    // log the update and report the result.
    this.config.firmwareVersion = installed.version;
    this.firmwareBlockedEvses.clear();
    this.stopHeartbeat();
    await this.sendBootNotification('FirmwareUpdate');
    for (const evse of this.config.evses) {
      const statusNow =
        this.evseContexts.get(evse.evseId)?.transactionId != null
          ? (this.evseConnectorStatus.get(evse.evseId) ?? 'Occupied')
          : this.evseContexts.get(evse.evseId)?.cablePlugged === true
            ? 'Occupied'
            : 'Available';
      this.evseConnectorStatus.set(evse.evseId, statusNow);
      await this.sendStatusNotification(evse.evseId, evse.connectorId, statusNow);
    }
    await this.sendSecurityEventNotification('FirmwareUpdated');
    await status('Installed');
    finish();
  }

  /** Connectors made Unavailable for a pending installation become Available again. */
  private async releaseFirmwareBlockedConnectors(): Promise<void> {
    for (const evseId of Array.from(this.firmwareBlockedEvses)) {
      this.firmwareBlockedEvses.delete(evseId);
      this.evseConnectorStatus.set(evseId, 'Available');
      await this.sendStatusNotification(evseId, this.getConnectorId(evseId), 'Available').catch(
        () => {},
      );
    }
  }

  // ---------------------------------------------------------------------------
  // TriggerMessage dispatch
  // ---------------------------------------------------------------------------

  private async handleTriggerMessage(
    requestedMessage: string,
    triggerPayload: Record<string, unknown>,
  ): Promise<void> {
    const evseObj = triggerPayload['evse'] as Record<string, unknown> | undefined;
    const triggerEvseId = evseObj?.['id'] as number | undefined;
    const triggerConnectorId =
      (triggerPayload['connectorId'] as number | undefined) ??
      (evseObj?.['connectorId'] as number | undefined);

    try {
      switch (requestedMessage) {
        case 'BootNotification': {
          // A triggered boot replaces the scheduled retry, so it reports the connectors too.
          const wasAccepted = this.bootStatus === 'Accepted';
          await this.sendBootNotification('Triggered');
          if (!wasAccepted && this.bootStatus === 'Accepted') {
            await this.reportConnectorsAfterAccept();
          }
          break;
        }
        case 'Heartbeat':
          await this.sendHeartbeat();
          break;
        case 'StatusNotification': {
          const snEvseId = triggerEvseId ?? 1;
          const snConnId = triggerConnectorId ?? 1;
          // Send actual connector status, not always Available
          const currentStatus = this.evseConnectorStatus.get(snEvseId) ?? 'Available';
          await this.sendStatusNotification(snEvseId, snConnId, currentStatus);
          break;
        }
        case 'MeterValues': {
          const targetEvseId = triggerEvseId ?? 1;
          const gen = this.meterGens.get(targetEvseId);
          if (gen == null) break;

          const tx = await this.getActiveTransaction(targetEvseId);
          const isIdle = tx == null || (this.evseIdle.get(targetEvseId) ?? false);
          gen.tick(isIdle, this.evsePowerLimits.get(targetEvseId) ?? null);

          const measurands = tx != null ? this.getSampledMeasurands() : this.getAlignedMeasurands();
          const sampledValues = gen.generate(
            measurands.length > 0
              ? measurands
              : ['Energy.Active.Import.Register', 'Power.Active.Import'],
            this.is16,
          );

          // Add context: 'Trigger' to all sampled values
          for (const sv of sampledValues) {
            (sv as unknown as Record<string, unknown>)['context'] = 'Trigger';
          }

          await this.sendMeterValues(
            targetEvseId,
            sampledValues as unknown as Array<Record<string, unknown>>,
            tx?.transactionId,
          );
          break;
        }
        case 'FirmwareStatusNotification':
          await this.sendFirmwareStatusNotification(this.firmwareUpdateStatus);
          break;
        case 'DiagnosticsStatusNotification':
          await this.sendDiagnosticsStatusNotification('Idle');
          break;
        case 'LogStatusNotification':
          await this.sendLogStatusNotification(this.logUploadStatus);
          break;
        case 'TransactionEvent': {
          // Find any EVSE with an active transaction (prefer triggerEvseId if given)
          const evseList =
            triggerEvseId != null
              ? this.config.evses.filter((e) => e.evseId === triggerEvseId)
              : this.config.evses;
          for (const evse of evseList) {
            const tx = await this.getActiveTransaction(evse.evseId);
            if (tx != null) {
              // Include chargingState and meterValue per OCPP spec
              const chState = this.evseChargingState.get(evse.evseId) ?? 'Charging';
              const txGen = this.meterGens.get(evse.evseId);
              let txMeterValue: Array<Record<string, unknown>> | undefined;
              if (txGen != null) {
                const txIdle = this.evseIdle.get(evse.evseId) ?? false;
                txGen.tick(txIdle, this.evsePowerLimits.get(evse.evseId) ?? null);
                const txMeasurands = this.getSampledMeasurands();
                const txSampled = txGen.generate(
                  txMeasurands.length > 0
                    ? txMeasurands
                    : ['Energy.Active.Import.Register', 'Power.Active.Import'],
                  this.is16,
                );
                txMeterValue = [
                  {
                    timestamp: new Date().toISOString(),
                    sampledValue: txSampled,
                  },
                ];
              }
              const txEventOpts: {
                triggerReason: string;
                transactionId: string;
                chargingState: string;
                meterValue?: Array<Record<string, unknown>>;
              } = {
                triggerReason: 'Trigger',
                transactionId: tx.transactionId,
                chargingState: chState,
              };
              if (txMeterValue != null) {
                txEventOpts.meterValue = txMeterValue;
              }
              await this.sendTransactionEvent(evse.evseId, 'Updated', txEventOpts);
              break;
            }
          }
          break;
        }
        case 'SignChargingStationCertificate':
          await this.requestCertificateSigning('ChargingStationCertificate');
          break;
        case 'SignV2GCertificate':
          await this.requestCertificateSigning('V2GCertificate');
          break;
        case 'PublishFirmwareStatusNotification':
          await this.sendPublishFirmwareStatusNotification('Idle');
          break;
        case 'CustomTrigger': {
          // Custom trigger: send a Heartbeat as the triggered response
          await this.sendHeartbeat();
          break;
        }
      }
    } catch (err) {
      logger.warn(
        { err, stationId: this.config.stationId, requestedMessage },
        'Triggered message failed',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation helpers
  // ---------------------------------------------------------------------------

  private async simulateReset(resetType: string): Promise<void> {
    // Use version-appropriate stop reason
    let reason: string;
    if (this.is16) {
      reason = resetType === 'Immediate' ? 'HardReset' : 'SoftReset';
    } else {
      // 2.1 has no SoftReset stop reason (ReasonEnumType)
      reason = resetType === 'Immediate' ? 'ImmediateReset' : 'Reboot';
    }
    const bootReason = resetType === 'Immediate' ? 'RemoteReset' : 'ScheduledReset';

    // Stop all active transactions
    for (const evse of this.config.evses) {
      const tx = await this.getActiveTransaction(evse.evseId);
      if (tx != null) {
        await this.stopCharging(evse.evseId, reason);
      }
    }

    // Send StatusNotification Unavailable for all connectors before reboot
    for (const evse of this.config.evses) {
      try {
        await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Unavailable');
      } catch (err) {
        logger.debug(
          {
            err,
            stationId: this.config.stationId,
            evseId: evse.evseId,
            connectorId: evse.connectorId,
            status: 'Unavailable',
          },
          'StatusNotification not delivered, the status is reported on reconnect',
        );
      }
    }

    this.stopHeartbeat();

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (this.destroyed) return;

    // A pending password or security profile change applies on a real reconnect.
    const candidates = this.rebootConnections();
    if (candidates != null) {
      this.rebootCandidates = candidates;
      this.rebootOnReconnect = true;
      this.client.reconnectNow();
      return;
    }

    // OCPP 1.6: a Hard or Soft reset reboots the Charge Point, so it opens a new
    // connection and boots on it, reporting connector 0 and its connectors.
    if (this.is16) {
      for (const evse of this.config.evses) {
        this.evseConnectorStatus.set(evse.evseId, 'Available');
        const ctx = this.evseContexts.get(evse.evseId) as EvseContext;
        ctx.state = 'Available';
        ctx.cablePlugged = false;
        ctx.authorizedToken = null;
        ctx.transactionId = null;
      }
      this.rebootOnReconnect = true;
      this.client.reconnectNow();
      return;
    }

    try {
      await this.sendBootNotification(bootReason);
      for (const evse of this.config.evses) {
        this.evseConnectorStatus.set(evse.evseId, 'Available');
        const ctx = this.evseContexts.get(evse.evseId) as EvseContext;
        ctx.state = 'Available';
        ctx.cablePlugged = false;
        ctx.authorizedToken = null;
        ctx.transactionId = null;
        await this.sendStatusNotification(evse.evseId, evse.connectorId, 'Available');
      }
    } catch (err) {
      logger.warn({ err, stationId: this.config.stationId, resetType }, 'Boot after reset failed');
    }
  }

  /**
   * OCPP 2.1 B13: Reset ImmediateAndResume with ongoing transactions. Reports
   * ResetCommand for every ongoing transaction, stops the energy offer, resets
   * (a full reboot with B01 cold boot when no evseId is given), then resumes
   * every transaction with TxResumed. Energy transfer resumes only when
   * TxCtrlr.AllowEnergyTransferResumption is true; a transaction that was
   * Charging is otherwise resumed as SuspendedEVSE. All transactions are
   * resumed regardless of TxCtrlr.ResumptionTimeout (B13 remark).
   */
  private async resetAndResumeTransactions(evseIdFilter?: number): Promise<void> {
    const resumed: Array<{ evseId: number; transactionId: string; chargingState: string }> = [];
    for (const evse of this.config.evses) {
      if (evseIdFilter != null && evse.evseId !== evseIdFilter) continue;
      const transactionId = this.evseContexts.get(evse.evseId)?.transactionId;
      if (transactionId == null) continue;
      const chargingState = this.evseChargingState.get(evse.evseId) ?? 'Charging';
      const seqNo = (this.evseSeqNo.get(evse.evseId) ?? 0) + 1;
      this.evseSeqNo.set(evse.evseId, seqNo);
      await this.sendTransactionEvent(evse.evseId, 'Updated', {
        triggerReason: 'ResetCommand',
        transactionId,
        chargingState,
        seqNo,
      });
      // Remember the charging state and stop the energy offer.
      this.stopMeterLoop(evse.evseId);
      resumed.push({ evseId: evse.evseId, transactionId, chargingState });
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (this.destroyed) return;

    if (evseIdFilter == null) {
      // Reboot: B01 cold boot, connectors reported again.
      this.stopHeartbeat();
      await this.sendBootNotification('RemoteReset');
      for (const evse of this.config.evses) {
        const status = this.evseConnectorStatus.get(evse.evseId) ?? 'Available';
        await this.sendStatusNotification(evse.evseId, evse.connectorId, status);
      }
      await this.sendSecurityEventNotification('ResetOrReboot');
    }

    const allowEnergy = this.getConfigValue('TxCtrlr.AllowEnergyTransferResumption') === 'true';
    for (const r of resumed) {
      const chargingState =
        !allowEnergy && r.chargingState === 'Charging' ? 'SuspendedEVSE' : r.chargingState;
      this.evseChargingState.set(r.evseId, chargingState);
      const seqNo = (this.evseSeqNo.get(r.evseId) ?? 0) + 1;
      this.evseSeqNo.set(r.evseId, seqNo);
      await this.sendTransactionEvent(r.evseId, 'Updated', {
        triggerReason: 'TxResumed',
        transactionId: r.transactionId,
        chargingState,
        seqNo,
      });
      if (allowEnergy && chargingState === 'Charging') this.startMeterLoop(r.evseId);
    }
  }

  // The connections to try after a reboot when a security change is pending,
  // or null when the station reconnects as before.
  private rebootConnections(): ConnectionCandidate[] | null {
    const current = this.client.connection;
    if (this.is16) {
      const next = this.pendingSecurityProfile16;
      if (next == null) return null;
      // Moving from plain WebSocket (0/1) to TLS (2/3) needs the TLS endpoint;
      // a station already on TLS keeps its URL.
      const serverUrl =
        next >= 2 && current.securityProfile < 2
          ? cssConfig.OCPP_TLS_SERVER_URL
          : current.serverUrl;
      return [{ ...current, serverUrl, securityProfile: next }, current];
    }
    const priority = (this.getConfigValue('OCPPCommCtrlr.NetworkConfigurationPriority') ?? '')
      .split(',')
      .map((slot) => slot.trim())
      .filter((slot) => slot !== '');
    const candidates = priority.flatMap((slot): ConnectionCandidate[] => {
      const serverUrl = this.getConfigValue(`NetworkConfiguration.OcppCsmsUrl#${slot}`) ?? '';
      if (serverUrl === '') return [];
      return [
        {
          serverUrl,
          securityProfile: Number(
            this.getConfigValue(`NetworkConfiguration.SecurityProfile#${slot}`) ??
              current.securityProfile,
          ),
          password:
            this.getConfigValue(`NetworkConfiguration.BasicAuthPassword#${slot}`) ||
            this.getConfigValue('SecurityCtrlr.BasicAuthPassword') ||
            current.password,
        },
      ];
    });
    const first = candidates[0];
    if (
      first == null ||
      (first.serverUrl === current.serverUrl &&
        first.securityProfile === current.securityProfile &&
        first.password === current.password)
    ) {
      return null;
    }
    return candidates;
  }

  private chooseRebootConnection(attempt: number): void {
    if (this.rebootCandidates == null || this.rebootCandidates.length === 0) return;
    const index =
      Math.floor((attempt - 1) / CONNECTION_ATTEMPTS_PER_PROFILE) % this.rebootCandidates.length;
    const candidate = this.rebootCandidates[index];
    if (candidate == null) return;
    this.activeRebootCandidate = candidate;
    this.client.updateConnection(candidate);
  }

  // Connected with a new connection: make it permanent (OCPP 2.1 A05.FR.06).
  private async commitConnection(candidate: ConnectionCandidate): Promise<void> {
    this.rebootCandidates = null;
    this.activeRebootCandidate = null;
    if (this.is16) {
      if (candidate.securityProfile === this.pendingSecurityProfile16) {
        this.configVariables.set('SecurityProfile', {
          value: String(candidate.securityProfile),
          readonly: false,
        });
      }
      this.pendingSecurityProfile16 = null;
    } else {
      const current = Number(this.getConfigValue('SecurityCtrlr.SecurityProfile') ?? '0');
      if (candidate.securityProfile > current) {
        this.configVariables.set('SecurityCtrlr.SecurityProfile', {
          value: String(candidate.securityProfile),
          readonly: true,
        });
        const kept = (this.getConfigValue('OCPPCommCtrlr.NetworkConfigurationPriority') ?? '')
          .split(',')
          .map((slot) => slot.trim())
          .filter(
            (slot) =>
              Number(this.getConfigValue(`NetworkConfiguration.SecurityProfile#${slot}`) ?? '0') >=
              candidate.securityProfile,
          );
        this.configVariables.set('OCPPCommCtrlr.NetworkConfigurationPriority', {
          value: kept.join(','),
          readonly: false,
        });
      }
    }
    this.config.targetUrl = candidate.serverUrl;
    this.config.password = candidate.password;
    this.config.securityProfile = candidate.securityProfile;
    await this.persistConnection();
  }

  // A new Basic Auth password: use it from the next connection, reconnect to apply.
  private applyNewPassword(password: string): void {
    this.client.updateConnection({ password });
    this.config.password = password;
    void this.persistConnection();
    setTimeout(() => {
      if (!this.destroyed) this.client.simulateConnectionLoss();
    }, 2000);
  }

  // Keep css_stations in step so a simulator restart uses the current credentials.
  private async persistConnection(): Promise<void> {
    try {
      await this.sql`
        UPDATE css_stations
        SET target_url = ${this.config.targetUrl}, password = ${this.config.password ?? null},
            updated_at = now()
        WHERE id = ${this.config.id}
      `;
    } catch (err) {
      console.warn(
        `[${this.config.stationId}] Failed to save connection settings: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private isDestroyed(): boolean {
    return this.destroyed;
  }

  private startConnectionTimeoutTimer(evseId: number): void {
    this.cancelConnectionTimeoutTimer(evseId);
    const timeoutSec = Number(this.getConfigValue('ConnectionTimeOut') ?? '60');
    if (timeoutSec <= 0) return;
    const timer = setTimeout(() => {
      this.connectionTimeoutTimers.delete(evseId);
      const ctx = this.evseContexts.get(evseId);
      if (ctx == null || ctx.cablePlugged || ctx.transactionId != null) return;
      // Revert to Available
      ctx.state = 'Available';
      ctx.authorizedToken = null;
      ctx.authorizedTokenType = null;
      this.evseConnectorStatus.set(evseId, 'Available');
      const connectorId = this.getConnectorId(evseId);
      void this.sendStatusNotification(evseId, connectorId, 'Available').catch(() => {});
      void this.updateEvseStatus(evseId, 'Available').catch(() => {});
    }, timeoutSec * 1000);
    this.connectionTimeoutTimers.set(evseId, timer);
  }

  private cancelConnectionTimeoutTimer(evseId: number): void {
    const timer = this.connectionTimeoutTimers.get(evseId);
    if (timer != null) {
      clearTimeout(timer);
      this.connectionTimeoutTimers.delete(evseId);
    }
  }

  /** OCPP 2.1: Start an EVConnectionTimeout timer for a remote-started transaction
   *  where cable is not yet plugged in. When it fires the station ends the
   *  transaction with triggerReason EVConnectTimeout. */
  private startEvConnectTimeoutTimer(evseId: number, transactionId: string): void {
    this.cancelEvConnectTimeoutTimer(evseId);
    const timeoutSec = Number(
      this.getConfigValue('TxCtrlr.EVConnectionTimeOut') ??
        this.getConfigValue('ConnectionTimeOut') ??
        '60',
    );
    if (timeoutSec <= 0) return;
    const timer = setTimeout(() => {
      this.evConnectTimeoutTimers.delete(evseId);
      const ctx = this.evseContexts.get(evseId);
      if (ctx == null || ctx.cablePlugged) return;
      // End the transaction with EVConnectTimeout
      void (async () => {
        try {
          this.stopMeterLoop(evseId);
          const gen = this.meterGens.get(evseId);
          const meterStopWh = gen?.energyWh ?? 0;
          const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
          this.evseSeqNo.set(evseId, seqNo);
          await this.sendTransactionEvent(evseId, 'Ended', {
            triggerReason: 'EVConnectTimeout',
            transactionId,
            chargingState: 'Idle',
            stoppedReason: 'Timeout',
            seqNo,
          });
          await this.completeTransaction(transactionId, 'EVConnectTimeout', meterStopWh);
          // Reset EVSE state
          ctx.state = 'Available';
          ctx.transactionId = null;
          ctx.authorizedToken = null;
          ctx.authorizedTokenType = null;
          ctx.remoteStartId = null;
          this.evseConnectorStatus.set(evseId, 'Available');
          const connectorId = this.getConnectorId(evseId);
          await this.sendStatusNotification(evseId, connectorId, 'Available');
        } catch (err) {
          logger.warn(
            { err, stationId: this.config.stationId, evseId, transactionId },
            'Ending the transaction after the EV connect timeout failed',
          );
        }
      })();
    }, timeoutSec * 1000);
    this.evConnectTimeoutTimers.set(evseId, timer);
  }

  private cancelEvConnectTimeoutTimer(evseId: number): void {
    const timer = this.evConnectTimeoutTimers.get(evseId);
    if (timer != null) {
      clearTimeout(timer);
      this.evConnectTimeoutTimers.delete(evseId);
    }
  }

  /**
   * F01.FR.01: a remote start received before the EV is connected is authorized like a
   * local action. A token that is not Accepted no longer authorizes the EVSE.
   */
  private async authorizeRemoteStart(
    evseId: number,
    idToken: string,
    tokenType: string,
  ): Promise<void> {
    let status: string | undefined;
    try {
      const result = await this.sendAuthorize(idToken, tokenType);
      status = (result['idTokenInfo'] as Record<string, unknown> | undefined)?.['status'] as
        | string
        | undefined;
    } catch (err) {
      console.warn(
        `[${this.config.stationId}] Authorize for remote start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const ctx = this.evseContexts.get(evseId);
    // A response without idTokenInfo is malformed: keep the remote start
    if (status == null || status === 'Accepted' || ctx == null) return;
    if (ctx.transactionId != null || ctx.authorizedToken !== idToken) return;
    console.log(
      `[${this.config.stationId}] Remote start on EVSE ${String(evseId)} not authorized: ${status}`,
    );
    this.cancelEvConnectTimeoutTimer(evseId);
    ctx.state = 'Available';
    ctx.authorizedToken = null;
    ctx.authorizedTokenType = null;
    ctx.remoteStartId = null;
  }

  /** OCPP 2.1: EVConnectionTimeOut of an authorization without a cable (a remote start
   *  or a local authorize before the EV is connected). The simulator starts a
   *  transaction only with the cable connected and authorized (PowerPathClosed; PICS
   *  C-09.2 and C-51 unsupported), so no transaction exists yet. When the timer fires
   *  the authorization ends (C01.FR.26) and no TransactionEvent is sent: TC_C_100_CS,
   *  TC_E_05_CS, TC_E_39_CS and TC_F_04_CS expect one only when the transaction started
   *  at Authorized or ParkingBayOccupancy. The StatusNotification Available is the
   *  optional notification those test cases allow. */
  private startEvConnectTimeoutTimerPreTx(evseId: number): void {
    this.cancelEvConnectTimeoutTimer(evseId);
    const timeoutSec = Number(
      this.getConfigValue('TxCtrlr.EVConnectionTimeOut') ??
        this.getConfigValue('ConnectionTimeOut') ??
        '60',
    );
    if (timeoutSec <= 0) return;
    const timer = setTimeout(() => {
      this.evConnectTimeoutTimers.delete(evseId);
      const ctx = this.evseContexts.get(evseId);
      if (ctx == null || ctx.cablePlugged || ctx.transactionId != null) return;
      ctx.state = 'Available';
      ctx.authorizedToken = null;
      ctx.authorizedTokenType = null;
      ctx.remoteStartId = null;
      this.evseConnectorStatus.set(evseId, 'Available');
      const connectorId = this.getConnectorId(evseId);
      void this.sendStatusNotification(evseId, connectorId, 'Available').catch(() => {});
      void this.updateEvseStatus(evseId, 'Available').catch(() => {});
    }, timeoutSec * 1000);
    this.evConnectTimeoutTimers.set(evseId, timer);
  }

  private async simulateFirmwareUpdate(location: string, requestId?: number): Promise<void> {
    const delay = () => new Promise((resolve) => setTimeout(resolve, 500));
    const send = async (status: string) => {
      if (this.isDestroyed()) return false;
      await delay();
      if (this.isDestroyed()) return false;
      this.firmwareUpdateStatus = status;
      await this.sendFirmwareStatusNotification(status, requestId);
      return true;
    };

    try {
      // Simulate download failure for unreachable/nonexistent URLs
      if (location.includes('does_not_exist')) {
        await send('Downloading');
        await send('DownloadFailed');
        this.firmwareUpdateStatus = 'Idle';
        return;
      }

      if (!(await send('Downloading'))) return;
      if (!(await send('Downloaded'))) return;

      // Simulate installation failure for invalid firmware
      if (location.includes('invalid_firmware')) {
        await send('InstallationFailed');
        this.firmwareUpdateStatus = 'Idle';
        return;
      }

      if (!(await send('Installing'))) return;

      // Reboot after installing (station sends BootNotification)
      await this.sendBootNotification(this.is16 ? 'FirmwareUpdate' : 'FirmwareUpdate');

      if (!(await send('Installed'))) return;
      this.firmwareUpdateStatus = 'Idle';
    } catch (err) {
      logger.warn(
        { err, stationId: this.config.stationId, location, requestId },
        'Firmware update stopped, status set to Idle',
      );
      this.firmwareUpdateStatus = 'Idle';
    }
  }

  private async simulateLogUpload(requestId: number, remoteLocation: string): Promise<void> {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Simulate failure for nonexistent or redirect URLs
    if (remoteLocation.includes('nonexistent') || remoteLocation.includes('redirect')) {
      await delay(500);
      if (this.destroyed) return;
      this.logUploadStatus = 'UploadFailure';
      try {
        await this.sendLogStatusNotification('UploadFailure', requestId);
      } catch (err) {
        logger.warn(
          { err, stationId: this.config.stationId, requestId },
          'LogStatusNotification UploadFailure failed',
        );
      }
      this.logUploadStatus = 'Idle';
      this.activeLogUploadRequestId = null;
      return;
    }

    const statuses = ['Uploading', 'Uploaded'];
    const delays = [500, 1000];

    for (let i = 0; i < statuses.length; i++) {
      await delay(delays[i] as number);
      if (this.destroyed) return;
      try {
        this.logUploadStatus = statuses[i] as string;
        await this.sendLogStatusNotification(statuses[i] as string, requestId);
      } catch (err) {
        logger.warn(
          { err, stationId: this.config.stationId, requestId },
          'LogStatusNotification failed, log upload stopped',
        );
        return;
      }
    }
    this.logUploadStatus = 'Idle';
    this.activeLogUploadRequestId = null;
  }

  // ---------------------------------------------------------------------------
  // Variable monitoring (OCPP 2.1 N07 events, N11-N15 periodic event streams)
  // ---------------------------------------------------------------------------

  /**
   * Current value of a monitored variable: EVSE Power (W) from the meter,
   * EVSE / Connector AvailabilityState from the connector status, otherwise
   * the device model value. Null when the simulator does not know it.
   */
  private monitoredValue(
    component: Record<string, unknown>,
    variableName: string,
  ): number | string | null {
    const name = component['name'] as string;
    const evse = component['evse'] as { id?: number; connectorId?: number } | undefined;
    const evseId = evse?.id;
    if (variableName === 'Power' && name === 'EVSE' && evseId != null) {
      const gen = this.meterGens.get(evseId);
      if (gen == null) return null;
      return this.getActiveTransactionSync(evseId) != null ? gen.currentPowerW : 0;
    }
    if (variableName === 'AvailabilityState' && (name === 'EVSE' || name === 'Connector')) {
      return evseId != null ? (this.evseConnectorStatus.get(evseId) ?? 'Available') : null;
    }
    const scope =
      evseId != null && evse?.connectorId != null
        ? `[${String(evseId)},${String(evse.connectorId)}]`
        : evseId != null
          ? `[${String(evseId)}]`
          : '';
    const raw = this.getConfigValue(`${name}${scope}.${variableName}`);
    if (raw == null) return null;
    const num = Number(raw);
    return raw !== '' && Number.isFinite(num) ? num : raw;
  }

  private monitorMatches(
    monitor: VariableMonitor,
    component: Record<string, unknown>,
    variableName: string,
  ): boolean {
    if (monitor.component['name'] !== component['name']) return false;
    if (monitor.variable['name'] !== variableName) return false;
    const mEvse = monitor.component['evse'] as { id?: number; connectorId?: number } | undefined;
    const cEvse = component['evse'] as { id?: number; connectorId?: number } | undefined;
    if (mEvse?.id != null && mEvse.id !== cEvse?.id) return false;
    if (mEvse?.connectorId != null && mEvse.connectorId !== cEvse?.connectorId) return false;
    return true;
  }

  /**
   * N07: evaluate the threshold and delta monitors of a variable whose value
   * is now `value`. Returns the events to report (severity filtered by the
   * MonitoringLevel). A monitor's first observation only sets its baseline.
   */
  private evaluateMonitors(
    component: Record<string, unknown>,
    variableName: string,
    value: number | string,
    transactionId?: string | null,
    reportedValue?: string,
  ): MonitorEvent[] {
    if (this.is16) return [];
    if (this.getConfigValue('MonitoringCtrlr.Enabled') === 'false') return [];
    const events: MonitorEvent[] = [];
    for (const monitor of this.variableMonitors.values()) {
      if (!this.monitorMatches(monitor, component, variableName)) continue;
      if (monitor.transaction === true && transactionId == null) continue;
      const fire = (trigger: string, cleared: boolean): void => {
        if (monitor.severity > this.monitoringLevel) return;
        const event: Record<string, unknown> = {
          eventId: ++this.eventIdCounter,
          timestamp: new Date().toISOString(),
          trigger,
          actualValue: reportedValue ?? String(value),
          variableMonitoringId: monitor.id,
          eventNotificationType: monitorNotificationType(monitor),
          component: monitor.component['evse'] != null ? monitor.component : component,
          variable: monitor.variable,
          severity: monitor.severity,
        };
        if (cleared) event['cleared'] = true;
        if (transactionId != null) event['transactionId'] = transactionId;
        events.push({ severity: monitor.severity, event });
      };
      const limit = monitor.value;
      if (monitor.type === 'UpperThreshold' || monitor.type === 'LowerThreshold') {
        if (typeof value !== 'number' || limit == null) continue;
        const beyond = monitor.type === 'UpperThreshold' ? value > limit : value < limit;
        if (beyond && !this.monitorExceeded.has(monitor.id)) {
          this.monitorExceeded.add(monitor.id);
          fire('Alerting', false);
        } else if (!beyond && this.monitorExceeded.has(monitor.id)) {
          this.monitorExceeded.delete(monitor.id);
          fire('Alerting', true);
        }
      } else if (monitor.type === 'Delta') {
        const base = this.monitorDeltaBase.get(monitor.id);
        if (base == null) {
          this.monitorDeltaBase.set(monitor.id, value);
          continue;
        }
        const changed =
          typeof value === 'number' && typeof base === 'number'
            ? value !== base && Math.abs(value - base) >= (limit ?? 0)
            : String(value) !== String(base);
        if (changed) {
          this.monitorDeltaBase.set(monitor.id, value);
          fire('Delta', false);
        }
      }
    }
    return events;
  }

  /**
   * Send monitoring events. Offline, an event is queued only when its severity
   * is at or below MonitoringCtrlr.OfflineQueuingSeverity (N07.FR.04);
   * otherwise it is dropped.
   */
  private dispatchMonitorEvents(events: MonitorEvent[]): void {
    for (const { severity, event } of events) {
      const payload = {
        generatedAt: new Date().toISOString(),
        seqNo: 0,
        tbc: false,
        eventData: [event],
      };
      const queueIfAllowed = (): void => {
        const queuing = Number(
          this.getConfigValue('MonitoringCtrlr.OfflineQueuingSeverity') ?? '-1',
        );
        if (Number.isFinite(queuing) && severity <= queuing) {
          this.queueOfflineMessage('NotifyEvent', payload);
        }
      };
      if (!this.client.isConnected) {
        queueIfAllowed();
        continue;
      }
      void this.client.sendCall('NotifyEvent', payload).catch(() => {
        if (!this.client.isConnected) queueIfAllowed();
      });
    }
  }

  /** Remove a monitor and stop what it was reporting (stream, periodic events). */
  private removeMonitor(id: number): void {
    this.variableMonitors.delete(id);
    this.monitorDeltaBase.delete(id);
    this.monitorExceeded.delete(id);
    this.stopPeriodicNotifyEvents(id);
    const stream = this.periodicStreams.get(id);
    if (stream != null) {
      // N13: the station closes the stream of a cleared monitor, after the
      // ClearVariableMonitoringResponse.
      setTimeout(() => {
        void this.closeStream(stream);
      }, 0);
    }
  }

  /**
   * N11-N13: a Periodic monitor reports its value every `value` seconds,
   * through a periodic event stream when it has periodicEventStream params and
   * the CSMS accepts the stream, otherwise through NotifyEvent (N11.FR.07).
   * A monitor updated without stream params flushes and closes its stream.
   */
  private async applyPeriodicMonitor(monitorId: number): Promise<void> {
    const monitor = this.variableMonitors.get(monitorId);
    const existing = this.periodicStreams.get(monitorId);
    if (monitor == null || monitor.type !== 'Periodic' || (monitor.value ?? 0) <= 0) {
      this.stopPeriodicNotifyEvents(monitorId);
      if (existing != null) await this.closeStream(existing);
      return;
    }
    if (monitor.periodicEventStream == null) {
      if (existing != null) await this.closeStream(existing);
      this.startPeriodicNotifyEvents(monitor);
      return;
    }
    if (existing != null) {
      existing.interval = monitor.periodicEventStream.interval ?? existing.interval;
      existing.values = monitor.periodicEventStream.values ?? existing.values;
      this.restartStreamSampling(existing, monitor);
      this.scheduleStreamFlush(existing);
      return;
    }
    this.stopPeriodicNotifyEvents(monitorId);
    const stream: PeriodicStream = {
      id: ++this.streamIdCounter,
      monitorId,
      interval: monitor.periodicEventStream.interval ?? 0,
      values: monitor.periodicEventStream.values ?? 0,
      basetime: Date.now(),
      data: [],
      sampleTimer: null,
      flushTimer: null,
    };
    const params: Record<string, number> = {};
    if (monitor.periodicEventStream.interval != null) params['interval'] = stream.interval;
    if (monitor.periodicEventStream.values != null) params['values'] = stream.values;
    // Registered while the open request is pending: a CSMS request that arrives
    // together with the OpenPeriodicEventStreamResponse (GetPeriodicEventStream,
    // ClearVariableMonitoring) already sees the stream.
    this.periodicStreams.set(monitorId, stream);
    let accepted = false;
    try {
      const resp = await this.client.sendCall('OpenPeriodicEventStream', {
        constantStreamData: { id: stream.id, variableMonitoringId: monitorId, params },
      });
      accepted = resp['status'] === 'Accepted';
    } catch (err) {
      logger.warn(
        { err, stationId: this.config.stationId, monitorId },
        'OpenPeriodicEventStream failed, stream not opened',
      );
      accepted = false;
    }
    if (this.periodicStreams.get(monitorId) !== stream) return; // cleared or replaced meanwhile
    if (!accepted) {
      // N11.FR.07: fall back to NotifyEvent
      this.periodicStreams.delete(monitorId);
      this.startPeriodicNotifyEvents(monitor);
      return;
    }
    this.restartStreamSampling(stream, monitor);
    this.scheduleStreamFlush(stream);
  }

  private startPeriodicNotifyEvents(monitor: VariableMonitor): void {
    this.stopPeriodicNotifyEvents(monitor.id);
    const periodMs = (monitor.value ?? 0) * 1000;
    if (periodMs <= 0) return;
    const timer = setInterval(() => {
      const current = this.variableMonitors.get(monitor.id);
      if (current == null) {
        this.stopPeriodicNotifyEvents(monitor.id);
        return;
      }
      if (current.severity > this.monitoringLevel) return;
      const value = this.monitoredValue(current.component, current.variable['name'] as string);
      if (value == null) return;
      const evseId = (current.component['evse'] as { id?: number } | undefined)?.id;
      const transactionId = evseId != null ? this.getActiveTransactionSync(evseId) : null;
      const event: Record<string, unknown> = {
        eventId: ++this.eventIdCounter,
        timestamp: new Date().toISOString(),
        trigger: 'Periodic',
        actualValue: String(value),
        variableMonitoringId: current.id,
        eventNotificationType: monitorNotificationType(current),
        component: current.component,
        variable: current.variable,
        severity: current.severity,
      };
      if (transactionId != null) event['transactionId'] = transactionId;
      this.dispatchMonitorEvents([{ severity: current.severity, event }]);
    }, periodMs);
    this.periodicMonitorTimers.set(monitor.id, timer);
  }

  private stopPeriodicNotifyEvents(monitorId: number): void {
    const timer = this.periodicMonitorTimers.get(monitorId);
    if (timer != null) clearInterval(timer);
    this.periodicMonitorTimers.delete(monitorId);
  }

  /** Record the monitored value every monitor `value` seconds into the stream buffer. */
  private restartStreamSampling(stream: PeriodicStream, monitor: VariableMonitor): void {
    if (stream.sampleTimer != null) clearInterval(stream.sampleTimer);
    const periodMs = (monitor.value ?? 1) * 1000;
    stream.sampleTimer = setInterval(() => {
      const current = this.variableMonitors.get(stream.monitorId);
      if (current == null) return;
      const value = this.monitoredValue(current.component, current.variable['name'] as string);
      if (value == null) return;
      stream.data.push({ t: (Date.now() - stream.basetime) / 1000, v: String(value) });
      if (stream.values > 0 && stream.data.length >= stream.values) this.flushStream(stream);
    }, periodMs);
  }

  /** Send the buffered stream data every params.interval seconds. */
  private scheduleStreamFlush(stream: PeriodicStream): void {
    if (stream.flushTimer != null) clearInterval(stream.flushTimer);
    stream.flushTimer =
      stream.interval > 0
        ? setInterval(() => {
            this.flushStream(stream);
          }, stream.interval * 1000)
        : null;
  }

  /** NotifyPeriodicEventStream over the RPC framework SEND (no response). */
  private flushStream(stream: PeriodicStream): void {
    if (stream.data.length === 0) return;
    const data = stream.data.splice(0, stream.data.length);
    const sent = this.client.sendSend('NotifyPeriodicEventStream', {
      id: stream.id,
      pending: 0,
      basetime: new Date(stream.basetime).toISOString(),
      data: data.map((d) => ({ t: Math.round(d.t * 1000) / 1000, v: d.v })),
    });
    if (!sent) {
      // Not connected: keep the data for the next send.
      stream.data.unshift(...data);
      return;
    }
    // Offsets of later data are relative to a new basetime.
    stream.basetime = Date.now();
  }

  private stopStreamTimers(stream: PeriodicStream): void {
    if (stream.sampleTimer != null) clearInterval(stream.sampleTimer);
    if (stream.flushTimer != null) clearInterval(stream.flushTimer);
    stream.sampleTimer = null;
    stream.flushTimer = null;
  }

  /** N13: send what is buffered, then ClosePeriodicEventStream. */
  private async closeStream(stream: PeriodicStream): Promise<void> {
    this.stopStreamTimers(stream);
    this.flushStream(stream);
    this.periodicStreams.delete(stream.monitorId);
    try {
      await this.client.sendCall('ClosePeriodicEventStream', { id: stream.id });
    } catch (err) {
      logger.debug(
        { err, stationId: this.config.stationId, streamId: stream.id },
        'ClosePeriodicEventStream failed, the CSMS drops the streams of a disconnected station',
      );
    }
  }

  /**
   * What the station's display shows for an EVSE (O01): the highest-priority
   * configured message that applies now (start/end time, the EVSE state, the
   * transaction), most recent first within a priority. The content is in the
   * EV driver's preferred language when the message has it, otherwise the
   * main message. Null when no message applies.
   */
  displayedMessage(evseId: number): { id: number; content: string; language?: string } | null {
    if (this.is16) return null;
    const now = Date.now();
    const transactionId = this.evseContexts.get(evseId)?.transactionId ?? null;
    const connectorStatus = this.evseConnectorStatus.get(evseId) ?? 'Available';
    const state =
      connectorStatus === 'Faulted'
        ? 'Faulted'
        : connectorStatus === 'Unavailable'
          ? 'Unavailable'
          : transactionId != null && this.evseChargingState.get(evseId) === 'Charging'
            ? 'Charging'
            : transactionId == null
              ? 'Idle'
              : null;
    const rank: Record<string, number> = { AlwaysFront: 0, InFront: 1, NormalCycle: 2 };
    const candidates = Array.from(this.displayMessagesCache.values()).filter((m) => {
      const start = Date.parse((m['startDateTime'] as string | undefined) ?? '');
      const end = Date.parse((m['endDateTime'] as string | undefined) ?? '');
      if (Number.isFinite(start) && start > now) return false;
      if (Number.isFinite(end) && end <= now) return false;
      if (m['state'] != null && m['state'] !== state) return false;
      if (m['transactionId'] != null && m['transactionId'] !== transactionId) return false;
      return true;
    });
    candidates.sort(
      (a, b) => (rank[a['priority'] as string] ?? 3) - (rank[b['priority'] as string] ?? 3),
    );
    const shown = candidates[0];
    if (shown == null) return null;
    const language = this.evseDriverLanguage.get(evseId);
    const contents = [
      shown['message'] as Record<string, unknown> | undefined,
      ...((shown['messageExtra'] ?? []) as Array<Record<string, unknown>>),
    ].filter((c): c is Record<string, unknown> => c != null);
    const chosen =
      (language != null ? contents.find((c) => c['language'] === language) : undefined) ??
      contents[0];
    if (chosen == null) return null;
    const result: { id: number; content: string; language?: string } = {
      id: shown['id'] as number,
      content: String(chosen['content']),
    };
    if (typeof chosen['language'] === 'string') result.language = chosen['language'];
    return result;
  }

  private seedDefaultMonitors(): void {
    // Factory-default (preconfigured) Delta monitors on AvailabilityState with
    // severity 9 (Debug). SetMonitoringBase HardWiredOnly removes them and
    // FactoryDefault restores them. Severity 9 leaves the common severities free
    // for CSMS monitors (N04.FR.10: Duplicate is per type and severity).
    const csMonId = ++this.monitorIdCounter;
    this.variableMonitors.set(csMonId, {
      id: csMonId,
      type: 'Delta',
      severity: 9,
      component: { name: 'ChargingStation' },
      variable: { name: 'AvailabilityState' },
      isHardwired: false,
      preconfigured: true,
    });

    for (const evse of this.config.evses) {
      const evseMonId = ++this.monitorIdCounter;
      this.variableMonitors.set(evseMonId, {
        id: evseMonId,
        type: 'Delta',
        severity: 9,
        component: { name: 'EVSE', evse: { id: evse.evseId } },
        variable: { name: 'AvailabilityState' },
        isHardwired: false,
        preconfigured: true,
      });
    }

    // Seed one hardwired monitor at high ID (for TC_N_44 clear-rejected test)
    const hwId = 1000;
    this.variableMonitors.set(hwId, {
      id: hwId,
      type: 'PeriodicClockAligned',
      severity: 0,
      component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
      variable: { name: 'Available' },
      isHardwired: true,
    });
  }

  private isKnownComponent(component: Record<string, unknown>): boolean {
    const name = component['name'] as string;
    if (name === 'ChargingStation') return true;
    if (name === 'EVSE') {
      const evse = component['evse'] as Record<string, unknown> | undefined;
      if (evse != null) {
        const evseId = evse['id'] as number;
        return this.config.evses.some((e) => e.evseId === evseId);
      }
      return true;
    }
    if (name === 'Connector') return true;
    // Any other component of the device model (OCPPCommCtrlr, SecurityCtrlr, ...)
    for (const key of this.configVariables.keys()) {
      if (key.startsWith(name + '.') || key.startsWith(name + '[')) return true;
    }
    return false;
  }

  private isKnownVariable(
    component: Record<string, unknown>,
    variable: Record<string, unknown>,
  ): boolean {
    const compName = component['name'] as string;
    const varName = variable['name'] as string;
    const knownVars: Record<string, string[]> = {
      ChargingStation: ['AvailabilityState', 'Model', 'VendorName'],
      EVSE: ['AvailabilityState', 'Power'],
      Connector: ['AvailabilityState', 'Available', 'ConnectorType'],
    };
    if (knownVars[compName]?.includes(varName) === true) return true;
    // Any other variable of the device model
    for (const key of this.configVariables.keys()) {
      const parsed = this.parseConfigKey(key);
      if (parsed.componentName === compName && parsed.variableName === varName) return true;
    }
    return false;
  }

  private async simulateDiagnosticsUpload(location: string): Promise<void> {
    const delay = () => new Promise((resolve) => setTimeout(resolve, 500));
    try {
      // Simulate upload failure for unreachable locations
      if (location.includes('failedLocation') || location.includes('127.0.0.1')) {
        await delay();
        if (this.isDestroyed()) return;
        await this.sendDiagnosticsStatusNotification('Uploading');
        await delay();
        if (this.isDestroyed()) return;
        await this.sendDiagnosticsStatusNotification('UploadFailed');
        return;
      }
      await delay();
      if (this.isDestroyed()) return;
      await this.sendDiagnosticsStatusNotification('Uploading');
      await delay();
      if (this.isDestroyed()) return;
      await this.sendDiagnosticsStatusNotification('Uploaded');
    } catch (err) {
      logger.warn(
        { err, stationId: this.config.stationId, location },
        'Diagnostics upload stopped',
      );
    }
  }

  private async onReconnect(): Promise<void> {
    if (this.activeRebootCandidate != null) {
      await this.commitConnection(this.activeRebootCandidate);
    }
    if (!this.initialBootDone) {
      // The first connection failed in start(); this one runs the boot sequence.
      try {
        await this.bootAfterPowerUp();
        // Security events of the failed connection attempts
        await this.replayOfflineQueue();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${this.config.stationId}] Boot after reconnect failed: ${msg}`);
      }
      return;
    }
    // K01: profiles with invalidAfterOfflineDuration stop applying for good
    // after an offline period longer than their maxOfflineDuration.
    if (!this.is16 && this.offlineSince != null) {
      this.invalidateProfilesAfterOffline(Date.now() - this.offlineSince);
    }
    // Only a reboot (or a boot not yet Accepted) sends BootNotification again.
    // After a plain connection loss the station resumes the session (OCPP 1.6
    // 4.2, OCPP 2.1 B01.FR.01 and B04).
    const reboot = this.rebootOnReconnect || this.bootStatus !== 'Accepted';
    this.rebootOnReconnect = false;
    if (!reboot) {
      await this.resumeAfterConnectionLoss();
      return;
    }
    this.offlineSince = null;
    this.statusesAtDisconnect = null;
    try {
      await this.updateStationStatus('booting');
      await this.sendBootNotification('PowerUp');
      // Pending/Rejected: the boot retry timer reports the statuses once Accepted.
      if (this.bootStatus !== 'Accepted') return;
      await this.sendChargePointStatus16();
      // Report actual connector status (may have changed while offline)
      for (const evse of this.config.evses) {
        const ctx = this.evseContexts.get(evse.evseId);
        const preserved = this.preservedTransactions.get(evse.evseId);
        // If we have a preserved transaction, report Occupied (cable still connected)
        const currentStatus =
          preserved != null
            ? 'Occupied'
            : (this.evseConnectorStatus.get(evse.evseId) ?? 'Available');
        if (preserved != null) {
          this.evseConnectorStatus.set(evse.evseId, 'Occupied');
          if (ctx != null) ctx.state = 'Occupied';
        }
        await this.sendStatusNotification(evse.evseId, evse.connectorId, currentStatus);
      }
      await this.sendStartupSecurityEvent();
      if (this.is16) await this.stopInterruptedTransactions16();
      // Handle preserved transaction resumption (OCPP 2.1)
      if (!this.is16 && this.preservedTransactions.size > 0) {
        await this.handleTransactionResumption();
      }
      // Replay queued offline messages
      await this.replayOfflineQueue();
      await this.updateStationStatus('available');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Reconnect startup failed: ${msg}`);
    }
  }

  /**
   * OCPP 2.1 CSMS root certificates the station trusts: the CA it was
   * provisioned with and the installed CSMSRootCertificates.
   */
  private csmsRootCertificates(): X509Certificate[] {
    const provisioned =
      this.config.caCert != null ? (parseCertificateChain(this.config.caCert) ?? []) : [];
    return [...this.storedCertificates('CSMSRootCertificate'), ...provisioned];
  }

  /** OCPP 2.1: the TLS trust store follows the installed CSMS root certificates. */
  private refreshTrustAnchors(): void {
    if (this.is16) return;
    this.client.setTrustAnchors(this.csmsRootCertificates().map((cert) => cert.toString()));
  }

  /** A05.FR.02: a valid CSMSRootCertificate is installed. */
  private hasValidCsmsRootCertificate(): boolean {
    return this.csmsRootCertificates().some((cert) => isWithinValidity(cert));
  }

  /** A05.FR.03: a valid ChargingStationCertificate (and its key) is installed. */
  private hasValidChargingStationCertificate(): boolean {
    const leaf = parseCertificateChain(this.config.clientCert ?? '')?.[0];
    return (
      leaf != null &&
      this.config.clientKey != null &&
      this.config.clientKey !== '' &&
      isWithinValidity(leaf) &&
      certificateMatchesPrivateKey(leaf, this.config.clientKey)
    );
  }

  /**
   * A02: generate a key pair and send its CSR in a SignCertificateRequest.
   * When the CSMS accepts it but no CertificateSignedRequest follows, resend
   * after CertSigningWaitMinimum, doubling the wait CertSigningRepeatTimes
   * times (A02.FR.17-19).
   */
  private async requestCertificateSigning(certificateType: string): Promise<void> {
    this.clearCertSigningTimer(certificateType);
    const v2g = certificateType === 'V2GCertificate';
    const organizationName =
      this.getConfigValue('SecurityCtrlr.OrganizationName') ?? this.config.vendorName;
    // A00.FR.511: CN of the Charging Station certificate is its serial number.
    const { csrPem, privateKeyPem } = await generateKeyPairAndCsr({
      commonName: v2g ? this.config.stationId : this.config.serialNumber,
      organizationName,
    });
    this.pendingCsrKeys.set(certificateType, [privateKeyPem]);
    await this.sendSignCertificateWithBackoff(certificateType, csrPem, 0);
  }

  private async sendSignCertificateWithBackoff(
    certificateType: string,
    csrPem: string,
    doublings: number,
  ): Promise<void> {
    const response = await this.sendSignCertificate(csrPem, certificateType);
    if (response['status'] !== 'Accepted') return;
    const waitMinimum = Number(this.getConfigValue('SecurityCtrlr.CertSigningWaitMinimum') ?? '');
    const repeatTimes = Number(this.getConfigValue('SecurityCtrlr.CertSigningRepeatTimes') ?? '');
    if (!Number.isFinite(waitMinimum) || waitMinimum <= 0) return;
    if (!Number.isFinite(repeatTimes) || doublings > repeatTimes) return;
    const timer = setTimeout(
      () => {
        this.certSigningTimers.delete(certificateType);
        if (this.destroyed || !this.pendingCsrKeys.has(certificateType)) return;
        void this.sendSignCertificateWithBackoff(certificateType, csrPem, doublings + 1).catch(
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[${this.config.stationId}] SignCertificate resend failed: ${msg}`);
          },
        );
      },
      waitMinimum * 1000 * Math.pow(2, doublings),
    );
    this.certSigningTimers.set(certificateType, timer);
  }

  private clearCertSigningTimer(certificateType: string): void {
    const timer = this.certSigningTimers.get(certificateType);
    if (timer != null) clearTimeout(timer);
    this.certSigningTimers.delete(certificateType);
  }

  /**
   * CertificateSignedRequest (A02.FR.06-08): accept a chain that is valid,
   * matches a CSR of this station and is issued by a trusted root; otherwise
   * reject it and raise InvalidChargingStationCertificate (A02.FR.07).
   */
  private handleCertificateSigned(payload: Record<string, unknown>): Record<string, unknown> {
    const certificateType =
      (payload['certificateType'] as string | undefined) ?? 'ChargingStationCertificate';
    const chainPem = (payload['certificateChain'] as string | undefined) ?? '';
    const v2g = certificateType === 'V2GCertificate';
    const chain = parseCertificateChain(chainPem);
    const leaf = chain?.[0];
    // A02.FR.06: the leaf carries the key of a CSR this station sent, and the
    // chain is valid and part of the CSO (or V2G) certificate hierarchy.
    const privateKey =
      leaf != null
        ? (this.pendingCsrKeys.get(certificateType) ?? []).find((key) =>
            certificateMatchesPrivateKey(leaf, key),
          )
        : undefined;
    const roots = v2g ? this.storedCertificates('V2GRootCertificate') : this.csmsRootCertificates();
    if (chain == null || leaf == null || privateKey == null || !chainsToTrustedRoot(chain, roots)) {
      console.log(
        `[${this.config.stationId}] CertificateSigned rejected: invalid ${certificateType}`,
      );
      void this.sendSecurityEventNotification(
        'InvalidChargingStationCertificate',
        undefined,
        `CertificateSignedRequest ${certificateType} chain failed validation`,
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.config.stationId}] Security event not sent: ${msg}`);
      });
      return { status: 'Rejected' };
    }
    this.clearCertSigningTimer(certificateType);
    if (v2g) {
      const issuer = chain[1] ?? roots.find((root) => isIssuedBy(leaf, root)) ?? leaf;
      const hashData = certificateHashData(leaf, issuer);
      this.installedCertificatesCache.set(hashData.serialNumber, {
        certificateType: 'V2GCertificateChain',
        certificateHashData: { ...hashData },
        certificate: chainPem,
      });
      return { status: 'Accepted' };
    }
    // Switch to the new certificate by reconnecting (A02.FR.08).
    this.config.clientCert = chainPem;
    this.config.clientKey = privateKey;
    this.client.updateConnection({ clientCert: chainPem, clientKey: privateKey });
    void this.persistClientCertificate();
    if (this.certificateReconnectTimer != null) clearTimeout(this.certificateReconnectTimer);
    this.certificateReconnectTimer = setTimeout(() => {
      this.certificateReconnectTimer = null;
      if (!this.destroyed) this.client.reconnectNow();
    }, 2000);
    return { status: 'Accepted' };
  }

  /**
   * Connection restored without a reboot: report the connector statuses that
   * changed while offline (all of them when the offline period exceeded
   * OCPPCommCtrlr.OfflineThreshold, 2.1 B04.FR.01/02) and send the queued
   * messages. OCPP 1.6 sends the queued transaction messages first, so the
   * Central System learns of an offline-started transaction before its
   * Charging status (OCTT TC_037_1).
   */
  private async resumeAfterConnectionLoss(): Promise<void> {
    const offlineMs = this.offlineSince == null ? 0 : Date.now() - this.offlineSince;
    const before = this.statusesAtDisconnect ?? new Map<number, string>();
    const thresholdSec = Number(this.getConfigValue('OCPPCommCtrlr.OfflineThreshold') ?? '');
    const reportAll =
      !this.is16 && Number.isFinite(thresholdSec) && offlineMs > thresholdSec * 1000;
    try {
      if (this.is16) await this.replayOfflineQueue();
      for (const evse of this.config.evses) {
        const current = this.evseConnectorStatus.get(evse.evseId) ?? 'Available';
        if (reportAll || before.get(evse.evseId) !== current) {
          await this.sendStatusNotification(evse.evseId, evse.connectorId, current);
        }
      }
      if (!this.is16) await this.replayOfflineQueue();
      // Reported: the next offline period starts from these statuses.
      this.offlineSince = null;
      this.statusesAtDisconnect = null;
      await this.updateStationStatus('available');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Resume after connection loss failed: ${msg}`);
    }
  }

  /** OCPP 1.6: stop the transactions a power loss interrupted, reason PowerLoss. */
  private async stopInterruptedTransactions16(): Promise<void> {
    const evseIds = [...this.interruptedTransactions16];
    this.interruptedTransactions16 = new Set();
    for (const evseId of evseIds) {
      if (this.evseContexts.get(evseId)?.transactionId == null) continue;
      await this.stopCharging(evseId, 'PowerLoss');
    }
  }

  /** OCPP 2.1 security event StartupOfTheDevice, sent once the boot is Accepted. */
  private async sendStartupSecurityEvent(): Promise<void> {
    if (this.is16) return;
    try {
      await this.sendSecurityEventNotification('StartupOfTheDevice');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.config.stationId}] StartupOfTheDevice security event failed: ${msg}`);
    }
  }

  /**
   * Handle transaction resumption after power cycle (OCPP 2.1 only).
   * Checks TxCtrlr.ResumptionTimeout to decide whether to resume or end
   * each preserved transaction.
   */
  private async handleTransactionResumption(): Promise<void> {
    const resumptionTimeoutStr = this.getConfigValue('TxCtrlr.ResumptionTimeout');
    const allowEnergyResumption =
      this.getConfigValue('TxCtrlr.AllowEnergyTransferResumption') === 'true';

    for (const [evseId, preserved] of this.preservedTransactions) {
      const elapsedSec = (Date.now() - preserved.powerLossTime) / 1000;

      // Determine if we should resume
      let shouldResume = false;
      if (resumptionTimeoutStr == null) {
        // Absent: station does not support resumption (E_114)
        shouldResume = false;
      } else {
        const resumptionTimeout = Number(resumptionTimeoutStr);
        if (resumptionTimeout === 0) {
          // Timeout=0: never resume (E_115)
          shouldResume = false;
        } else if (elapsedSec < resumptionTimeout) {
          // Within timeout: resume (E_112, E_113)
          shouldResume = true;
        } else {
          // Expired: do not resume (E_116)
          shouldResume = false;
        }
      }

      if (shouldResume) {
        // Resume the transaction: send TransactionEvent Updated with TxResumed
        const chargingState = allowEnergyResumption ? 'Charging' : 'SuspendedEVSE';
        const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
        this.evseSeqNo.set(evseId, seqNo);
        this.evseChargingState.set(evseId, chargingState);
        await this.sendTransactionEvent(evseId, 'Updated', {
          triggerReason: 'TxResumed',
          transactionId: preserved.transactionId,
          chargingState,
          seqNo,
        });
        // If energy transfer is allowed, restart the meter loop
        if (allowEnergyResumption) {
          this.startMeterLoop(evseId);
        }
      } else {
        // End the transaction: send TransactionEvent Ended with AbnormalCondition
        const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
        this.evseSeqNo.set(evseId, seqNo);
        await this.sendTransactionEvent(evseId, 'Ended', {
          triggerReason: 'AbnormalCondition',
          transactionId: preserved.transactionId,
          stoppedReason: 'PowerLoss',
          seqNo,
        });
        // Complete the transaction in DB
        const gen = this.meterGens.get(evseId);
        const meterStopWh = gen?.energyWh ?? 0;
        await this.completeTransaction(preserved.transactionId, 'PowerLoss', meterStopWh);
        // Clean up EVSE context
        const ctx = this.evseContexts.get(evseId);
        if (ctx != null) {
          ctx.transactionId = null;
          ctx.authorizedToken = null;
          ctx.authorizedTokenType = null;
          ctx.remoteStartId = null;
        }
        this.evsePowerLimits.set(evseId, null);
        this.evseIdle.set(evseId, false);
        this.evseChargingState.set(evseId, null);
        this.evseSeqNo.set(evseId, 0);
        this.evseMeterTick.set(evseId, 0);
        this.evseTransactionLimits.delete(evseId);
        this.evseTotalCost.delete(evseId);
        this.evseTransactionStartTime.delete(evseId);
        this.evseLimitReached.delete(evseId);
        this.evseLastDriverLimits.delete(evseId);
        this.evseInvalidIdMaxEnergy.delete(evseId);
        this.evseLastLocalCost.delete(evseId);

        // For E_116: after ending, if cable is still plugged, start a new transaction
        if (ctx?.cablePlugged === true) {
          const newTxId = randomUUID();
          const newSeqNo = 1;
          this.evseSeqNo.set(evseId, newSeqNo);
          this.evseChargingState.set(evseId, 'EVConnected');
          {
            ctx.transactionId = newTxId;
            ctx.state = 'EVConnected';
          }
          this.evseConnectorStatus.set(evseId, 'Occupied');
          await this.createTransaction(evseId, newTxId, '', '', 0);
          await this.sendTransactionEvent(evseId, 'Started', {
            triggerReason: 'CablePluggedIn',
            transactionId: newTxId,
            chargingState: 'EVConnected',
            seqNo: newSeqNo,
          });
        } else {
          // No cable: set connector to Available
          const connectorId = this.getConnectorId(evseId);
          this.evseConnectorStatus.set(evseId, 'Available');
          if (ctx != null) ctx.state = 'Available';
          await this.sendStatusNotification(evseId, connectorId, 'Available');
        }
      }
    }

    // Clear preserved transactions (in-memory + DB marker)
    this.preservedTransactions = new Map();
    void this.sql`
      UPDATE css_transactions
      SET preserved_at = NULL, preserved_data = NULL
      WHERE css_station_id = ${this.config.id}
        AND preserved_at IS NOT NULL
    `.catch((err: unknown) => {
      console.warn(
        `[${this.config.stationId}] preservation marker clear failed`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  private async replayOfflineQueue(): Promise<void> {
    if (this.replayingOfflineQueue) return;
    this.replayingOfflineQueue = true;
    try {
      await this.drainOfflineQueue();
    } finally {
      this.replayingOfflineQueue = false;
    }
  }

  private async drainOfflineQueue(): Promise<void> {
    while (this.offlineMessageQueue.length > 0) {
      // Peek, send, then dequeue: a message stays queued until the CSMS
      // acknowledges it, so a connection lost mid-replay keeps it for the next
      // reconnect and GetTransactionStatus still reports it (E14.FR.04).
      const msg = this.offlineMessageQueue[0];
      if (msg == null) break;
      let response: Record<string, unknown>;
      try {
        console.log(`[${this.config.stationId}] Replaying queued ${msg.action}`);
        response = await this.client.sendCall(msg.action, msg.payload);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!this.client.isConnected) {
          console.warn(
            `[${this.config.stationId}] Replay of ${msg.action} interrupted (${errMsg}), kept in queue`,
          );
          return;
        }
        // The CSMS answered with a CALLERROR or did not answer: drop it.
        this.dequeueOfflineMessage();
        console.error(`[${this.config.stationId}] Failed to replay ${msg.action}: ${errMsg}`);
        continue;
      }
      this.dequeueOfflineMessage();
      try {
        // Handle StartTransaction response (1.6): check if CS rejected the idTag
        if (msg.action === 'StartTransaction' && this.is16) {
          const idTagInfo = response['idTagInfo'] as Record<string, unknown> | undefined;
          const txId = response['transactionId'] as number | undefined;
          // The Central System assigned the transaction id: the session's queued
          // messages and the station's state move from the temporary id to it.
          if (msg.localTransactionId != null && txId != null) {
            await this.adoptCsmsTransactionId16(
              msg.localTransactionId,
              txId,
              msg.payload['connectorId'] as number,
            );
          }
          if (idTagInfo != null && idTagInfo['status'] !== 'Accepted' && txId != null) {
            const evseId = msg.payload['connectorId'] as number;
            const stopOnInvalid = this.getConfigValue('StopTransactionOnInvalidId') === 'true';
            if (stopOnInvalid) {
              // Stop the transaction with DeAuthorized reason
              await this.stopCharging(evseId, 'DeAuthorized');
            } else {
              // Suspend EVSE
              const connectorId = this.getConnectorId(evseId);
              this.evseConnectorStatus.set(evseId, 'SuspendedEVSE');
              await this.sendStatusNotification(evseId, connectorId, 'SuspendedEVSE');
            }
          }
        }

        // Handle TransactionEvent response (2.1): idTokenInfo answers the idToken
        // of the request, so only a request that carried one can be rejected.
        if (msg.action === 'TransactionEvent' && !this.is16 && msg.payload['idToken'] != null) {
          const idTokenInfo = response['idTokenInfo'] as Record<string, unknown> | undefined;
          if (idTokenInfo != null && idTokenInfo['status'] !== 'Accepted') {
            // Update auth cache with the CSMS response
            const idTokenObj = msg.payload['idToken'] as Record<string, unknown> | undefined;
            const tokenValue = idTokenObj?.['idToken'] as string | undefined;
            if (tokenValue != null) {
              this.cacheIdTokenInfo(tokenValue, idTokenInfo);
            }
            // E05 / C12: the transaction this queued message belongs to
            const info = msg.payload['transactionInfo'] as Record<string, unknown> | undefined;
            const evseId = await this.findEvseForTransaction(String(info?.['transactionId']));
            if (evseId != null) await this.handleRejectedTransactionIdToken(evseId);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[${this.config.stationId}] Failed to process replayed ${msg.action} response: ${errMsg}`,
        );
      }
    }
  }

  /**
   * OCPP 1.6: a StartTransaction sent while offline started the transaction under
   * a temporary local id. When the Central System answers the replayed
   * StartTransaction with its transactionId, the queued MeterValues and
   * StopTransaction of that session and the station's own state switch to it
   * before they are sent, as a real station does. The temporary id is kept in
   * memory only: after a simulator restart the queued messages keep it.
   */
  private async adoptCsmsTransactionId16(
    localTxId: string,
    csmsTxId: number,
    evseId: number,
  ): Promise<void> {
    const realTxId = String(csmsTxId);
    if (realTxId === localTxId) return;
    for (const m of this.offlineMessageQueue) {
      if (m.action !== 'MeterValues' && m.action !== 'StopTransaction') continue;
      if (String(m.payload['transactionId']) !== localTxId) continue;
      m.payload['transactionId'] = csmsTxId;
      await this.sql`
        UPDATE css_offline_messages
        SET payload = ${this.sql.json(m.payload as Parameters<postgres.Sql['json']>[0])}
        WHERE css_station_id = ${this.config.id} AND id = ${m.id}
      `.catch((err: unknown) => {
        console.warn(
          `[${this.config.stationId}] offline queue transaction id update failed`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    const ctx = this.evseContexts.get(evseId);
    if (ctx?.transactionId === localTxId) ctx.transactionId = realTxId;
    if (this.activeTransactionIds.get(evseId) === localTxId) {
      this.activeTransactionIds.set(evseId, realTxId);
    }
    const startToken = this.transactionStartTokens.get(localTxId);
    if (startToken != null) {
      this.transactionStartTokens.delete(localTxId);
      this.transactionStartTokens.set(realTxId, startToken);
    }
    await this.sql`
      UPDATE css_transactions SET transaction_id = ${realTxId}
      WHERE css_station_id = ${this.config.id} AND transaction_id = ${localTxId}
    `.catch((err: unknown) => {
      console.warn(
        `[${this.config.stationId}] transaction id update failed`,
        err instanceof Error ? err.message : String(err),
      );
    });
    console.log(
      `[${this.config.stationId}] Transaction ${localTxId} is ${realTxId} at the Central System`,
    );
  }

  /**
   * True when the offline queue holds a transaction-related message that is not
   * delivered yet (OCPP 2.1 E14): for the given transaction, or any when omitted.
   * A message stays queued until the CSMS acknowledges it (replayOfflineQueue).
   */
  private hasQueuedTransactionMessages(transactionId?: string): boolean {
    return this.offlineMessageQueue.some((m) => {
      if (m.action === 'TransactionEvent') {
        if (transactionId == null) return true;
        const info = m.payload['transactionInfo'] as Record<string, unknown> | undefined;
        return info?.['transactionId'] === transactionId;
      }
      // OCPP 1.6 transaction-related messages (3.7): StartTransaction,
      // StopTransaction, and MeterValues that carry a transactionId.
      const tx16 =
        m.action === 'StartTransaction' ||
        m.action === 'StopTransaction' ||
        (m.action === 'MeterValues' && m.payload['transactionId'] != null);
      if (!tx16) return false;
      return transactionId == null || String(m.payload['transactionId']) === transactionId;
    });
  }

  /**
   * OCPP 1.6 (3.7): send a transaction-related message (StopTransaction, or MeterValues
   * with a transactionId). Offline, or while older ones wait in the queue, it
   * joins the queue so the Central System receives them in order; a connection
   * lost while it is in flight keeps it for the reconnect.
   */
  private async sendTransactionMessage16(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.client.isConnected || this.hasQueuedTransactionMessages()) {
      this.queueOfflineMessage(action, payload);
      return;
    }
    try {
      await this.client.sendCall(action, payload);
    } catch (err) {
      // isConnected is a getter that changed during the await.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.client.isConnected) {
        this.queueOfflineMessage(action, payload);
        return;
      }
      throw err;
    }
  }

  /** Queue a message for later replay when back online. */
  private queueOfflineMessage(
    action: string,
    payload: Record<string, unknown>,
    localTransactionId?: string,
  ): void {
    this.enqueueOfflineMessage(action, payload, localTransactionId);
    console.log(
      `[${this.config.stationId}] Queued ${action} (${String(this.offlineMessageQueue.length)} in queue)`,
    );
  }

  /**
   * Simulate a power cycle: stop active transactions, disconnect, reconnect.
   * powerOffMs is how long the station stays without power.
   */
  async simulatePowerCycle(reason: string = 'PowerLoss', powerOffMs = 0): Promise<void> {
    // Stop all active transactions with the given reason
    for (const evse of this.config.evses) {
      const ctx = this.evseContexts.get(evse.evseId);
      if (ctx?.transactionId != null) {
        try {
          await this.stopCharging(evse.evseId, reason);
        } catch (err) {
          logger.warn(
            { err, stationId: this.config.stationId, evseId: evse.evseId, reason },
            'Stopping the transaction before the power cycle failed',
          );
        }
      }
    }
    // Drop the connection and come back up: the reconnect boots.
    this.rebootOnReconnect = true;
    this.client.reconnectNow(powerOffMs);
  }

  /**
   * Simulate a power loss without stopping the transactions first.
   * OCPP 2.1: on reconnect, the station checks TxCtrlr.ResumptionTimeout to
   * decide whether to resume or end the transaction (E_112-E_116).
   * powerOffMs is how long the station stays without power.
   */
  simulatePowerCyclePreserveTransactions(powerOffMs = 0): Promise<void> {
    if (this.is16) {
      // OCPP 1.6 has no transaction resumption. A Charge Point without back-up
      // power cannot stop its transactions before going down; it stops them
      // with reason PowerLoss once it is back up (OCTT TC_032_2).
      this.interruptedTransactions16 = new Set();
      for (const evse of this.config.evses) {
        if (this.evseContexts.get(evse.evseId)?.transactionId != null) {
          this.interruptedTransactions16.add(evse.evseId);
          this.stopMeterLoop(evse.evseId);
        }
      }
      this.rebootOnReconnect = true;
      this.client.reconnectNow(powerOffMs);
      return Promise.resolve();
    }

    // Save transaction state per EVSE before disconnecting. Persist the
    // preservation marker on css_transactions so a process restart between
    // power-loss and reconnect still finds the preserved transactions on boot.
    const preservedTransactions = new Map<
      number,
      { transactionId: string; idToken: string; tokenType: string; powerLossTime: number }
    >();
    const preservedAt = new Date();
    for (const evse of this.config.evses) {
      const ctx = this.evseContexts.get(evse.evseId);
      if (ctx?.transactionId != null) {
        const preservedEntry = {
          transactionId: ctx.transactionId,
          idToken: ctx.authorizedToken ?? '',
          tokenType: ctx.authorizedTokenType ?? 'ISO14443',
          powerLossTime: preservedAt.getTime(),
        };
        preservedTransactions.set(evse.evseId, preservedEntry);
        void this.sql`
          UPDATE css_transactions
          SET preserved_at = ${preservedAt}, preserved_data = ${this.sql.json(preservedEntry as Parameters<postgres.Sql['json']>[0])}
          WHERE css_station_id = ${this.config.id}
            AND transaction_id = ${ctx.transactionId}
        `.catch((err: unknown) => {
          console.warn(
            `[${this.config.stationId}] preservation marker write failed`,
            err instanceof Error ? err.message : String(err),
          );
        });
        this.stopMeterLoop(evse.evseId);
      }
    }

    this.preservedTransactions = preservedTransactions;

    // Drop the connection and come back up: the reconnect boots.
    this.rebootOnReconnect = true;
    this.client.reconnectNow(powerOffMs);
    return Promise.resolve();
  }

  /** Simulate a connector lock failure by sending a NotifyEvent with
   *  ConnectorPlugRetentionLock Problem = true. OCPP 2.1 only. */
  async simulateLockFailure(evseId: number, connectorId: number = 1): Promise<void> {
    if (this.is16) return;
    await this.sendNotifyEvent([
      {
        eventId: Date.now(),
        timestamp: new Date().toISOString(),
        trigger: 'Delta',
        actualValue: 'true',
        component: { name: 'ConnectorPlugRetentionLock', evse: { id: evseId, connectorId } },
        variable: { name: 'Problem' },
        eventNotificationType: 'HardWiredNotification',
      },
    ]);
  }

  // ---------------------------------------------------------------------------
  // Meter loop (private)
  // ---------------------------------------------------------------------------

  private startMeterLoop(evseId: number): void {
    this.stopMeterLoop(evseId);
    // A transaction resumed after a reboot can finish resuming after stop().
    if (this.destroyed) return;

    const gen = this.meterGens.get(evseId);
    if (gen == null) return;

    let meterTick = 0;

    const sendTick = (): void => {
      meterTick++;
      this.evseMeterTick.set(evseId, meterTick);

      const idle = this.evseIdle.get(evseId) ?? false;

      // OCPP 2.1 chargingState lifecycle
      if (!this.is16) {
        const txResult = this.getActiveTransactionSync(evseId);
        if (txResult != null) {
          const currentState = this.evseChargingState.get(evseId);

          // Tick 1: EVConnected -> Charging
          if (meterTick === 1 && currentState === 'EVConnected') {
            this.evseChargingState.set(evseId, 'Charging');
            const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
            this.evseSeqNo.set(evseId, seqNo);
            void this.sendTransactionEvent(evseId, 'Updated', {
              triggerReason: 'ChargingStateChanged',
              transactionId: txResult,
              chargingState: 'Charging',
              seqNo,
            }).catch(() => {});
          }
        }
      }

      // Advance simulation state
      gen.tick(idle, this.evsePowerLimits.get(evseId) ?? null);

      // N07: threshold and delta monitors on the EVSE Power
      if (!this.is16) {
        const powerTx = this.getActiveTransactionSync(evseId);
        this.dispatchMonitorEvents(
          this.evaluateMonitors(
            { name: 'EVSE', evse: { id: evseId } },
            'Power',
            powerTx != null ? gen.currentPowerW : 0,
            powerTx,
          ),
        );
      }

      // Read configured measurands
      const measurands = this.getSampledMeasurands();
      const sampledValues = gen.generate(measurands, this.is16);

      // Get active transaction for this EVSE (sync check using cached state)
      const txId = this.getActiveTransactionSync(evseId);

      // OCPP 2.1: send TransactionEvent Updated with MeterValuePeriodic during tx
      if (!this.is16 && txId != null) {
        const periodicValues = sampledValues.map((sv) => ({
          ...sv,
          context: 'Sample.Periodic',
        }));
        const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
        this.evseSeqNo.set(evseId, seqNo);
        void this.sendTransactionEvent(evseId, 'Updated', {
          triggerReason: 'MeterValuePeriodic',
          transactionId: txId,
          chargingState: this.evseChargingState.get(evseId) ?? 'Charging',
          seqNo,
          meterValue: [
            this.signMeterValue(evseId, {
              timestamp: new Date().toISOString(),
              sampledValue: periodicValues,
            }),
          ],
        }).catch(() => {});
      } else {
        void this.sendMeterValues(
          evseId,
          sampledValues as unknown as Array<Record<string, unknown>>,
          txId ?? undefined,
        ).catch(() => {});
      }

      // Update transaction in DB periodically
      if (txId != null) {
        void this.updateTransaction(txId, {
          currentPowerW: gen.currentPowerW,
          chargingState: this.evseChargingState.get(evseId) ?? null,
          seqNo: this.evseSeqNo.get(evseId) ?? 0,
        }).catch(() => {});
      }

      // OCPP 2.1: check for driver-set limit changes and send LimitSet
      if (!this.is16 && txId != null) {
        void this.checkDriverSetLimitChanges(evseId, txId).catch(() => {});
      }

      // OCPP 2.1: send RunningCost event if local cost calculation is active
      if (!this.is16 && txId != null) {
        void this.sendRunningCostIfNeeded(evseId, txId, gen).catch(() => {});
      }

      // E05.FR.03: energy allowed after a rejected idToken is used up
      const invalidIdMaxEnergy = this.evseInvalidIdMaxEnergy.get(evseId);
      if (!this.is16 && txId != null && invalidIdMaxEnergy != null) {
        if (gen.energyWh >= invalidIdMaxEnergy) {
          void this.suspendForInvalidId(evseId, txId).catch(() => {});
          return;
        }
      }

      // OCPP 2.1: check transaction limits (energy, time, cost)
      if (!this.is16 && txId != null && !(this.evseLimitReached.get(evseId) ?? false)) {
        void this.checkTransactionLimits(evseId, txId, gen).catch(() => {});
      }
    };

    const intervalMs = this.getSampledIntervalMs();
    sendTick();
    this.meterTimers.set(evseId, setInterval(sendTick, intervalMs));
  }

  private stopMeterLoop(evseId: number): void {
    const timer = this.meterTimers.get(evseId);
    if (timer != null) {
      clearInterval(timer);
      this.meterTimers.delete(evseId);
    }
  }

  /**
   * Check transaction limits (energy, time, cost) and send limit-reached events.
   * Called from the meter loop on each tick for OCPP 2.1 transactions.
   */
  /**
   * Check if driver-set limits (from config variables) changed since last report.
   * If changed, send a LimitSet TransactionEvent.
   */
  private async checkDriverSetLimitChanges(evseId: number, txId: string): Promise<void> {
    const current = this.getDriverSetLimits();
    const previous = this.evseLastDriverLimits.get(evseId) ?? null;

    // Compare: detect changes
    const changed =
      current?.maxEnergy !== previous?.maxEnergy ||
      current?.maxTime !== previous?.maxTime ||
      current?.maxCost !== previous?.maxCost;

    if (!changed) return;

    this.evseLastDriverLimits.set(evseId, current != null ? { ...current } : null);

    if (current == null) return;

    // Merge CSMS limits with driver limits to report the combined limit
    const csmsLimits = this.evseTransactionLimits.get(evseId);
    const combined: { maxEnergy?: number; maxTime?: number; maxCost?: number } = {};
    const mergedEnergy = this.pickMostRestrictive(current.maxEnergy, csmsLimits?.maxEnergy);
    if (mergedEnergy != null) combined.maxEnergy = mergedEnergy;
    const mergedTime = this.pickMostRestrictive(current.maxTime, csmsLimits?.maxTime);
    if (mergedTime != null) combined.maxTime = mergedTime;
    const mergedCost = this.pickMostRestrictive(current.maxCost, csmsLimits?.maxCost);
    if (mergedCost != null) combined.maxCost = mergedCost;

    // Reset limit-reached flag when limits change
    this.evseLimitReached.set(evseId, false);

    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason: 'LimitSet',
      transactionId: txId,
      chargingState: this.evseChargingState.get(evseId) ?? 'Charging',
      seqNo,
      transactionLimit: combined,
    });
  }

  /**
   * Send a RunningCost TransactionEvent if local cost calculation is active
   * and the cost has changed since last report.
   */
  private async sendRunningCostIfNeeded(
    evseId: number,
    txId: string,
    gen: MeterValueGenerator,
  ): Promise<void> {
    const localCost = this.calculateLocalCost(evseId, gen);
    if (localCost == null) return;

    const lastCost = this.evseLastLocalCost.get(evseId) ?? -1;
    // Only send if cost changed by at least 0.01 (avoid spamming)
    if (Math.abs(localCost - lastCost) < 0.01) return;

    this.evseLastLocalCost.set(evseId, localCost);

    // Find the tariff to get currency
    let currency = 'EUR';
    for (const entry of this.defaultTariffs.values()) {
      if (entry.evseId === 0 || entry.evseId === evseId) {
        currency = (entry.tariff['currency'] as string | undefined) ?? 'EUR';
        break;
      }
    }

    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason: 'RunningCost',
      transactionId: txId,
      chargingState: this.evseChargingState.get(evseId) ?? 'Charging',
      seqNo,
      costDetails: {
        totalCost: Math.round(localCost * 100) / 100,
        currency,
        totalEnergy: Math.round((gen.energyWh / 1000) * 100) / 100,
      },
    });
  }

  private async checkTransactionLimits(
    evseId: number,
    txId: string,
    gen: MeterValueGenerator,
  ): Promise<void> {
    const limits = this.evseTransactionLimits.get(evseId);
    const csLimits = this.getDriverSetLimits();
    if (limits == null && csLimits == null) return;

    // Merge CSMS limits and driver-set limits (use the most restrictive)
    const effectiveMaxEnergy = this.pickMostRestrictive(limits?.maxEnergy, csLimits?.maxEnergy);
    const effectiveMaxTime = this.pickMostRestrictive(limits?.maxTime, csLimits?.maxTime);
    const effectiveMaxCost = this.pickMostRestrictive(limits?.maxCost, csLimits?.maxCost);

    // Check energy limit (energyWh is cumulative in Wh, maxEnergy is also in Wh)
    if (effectiveMaxEnergy != null && gen.energyWh >= effectiveMaxEnergy) {
      this.evseLimitReached.set(evseId, true);
      await this.sendLimitReachedEvent(evseId, txId, 'EnergyLimitReached');
      return;
    }

    // Check time limit (maxTime in seconds)
    if (effectiveMaxTime != null) {
      const startTime = this.evseTransactionStartTime.get(evseId);
      if (startTime != null) {
        const elapsedSecs = (Date.now() - startTime) / 1000;
        if (elapsedSecs >= effectiveMaxTime) {
          this.evseLimitReached.set(evseId, true);
          await this.sendLimitReachedEvent(evseId, txId, 'TimeLimitReached');
          return;
        }
      }
    }

    // Check cost limit: local cost calculation (E16.FR.16) or the cost from CSMS (E16.FR.15)
    if (effectiveMaxCost != null) {
      const currentCost = this.usesLocalCostCalculation(evseId)
        ? this.calculateLocalCost(evseId, gen)
        : this.evseTotalCost.get(evseId);
      if (currentCost != null && currentCost >= effectiveMaxCost) {
        this.evseLimitReached.set(evseId, true);
        await this.sendLimitReachedEvent(evseId, txId, 'CostLimitReached');
        return;
      }
    }
  }

  /**
   * E16.FR.16: with TariffCostCtrlr enabled and a default tariff for the EVSE, the station
   * calculates the cost itself and ignores cost updates from CSMS. Otherwise CSMS
   * calculates the cost (E16.FR.11, E16.FR.15).
   */
  private usesLocalCostCalculation(evseId: number): boolean {
    if (this.getConfigValue('TariffCostCtrlr.Enabled') === 'false') return false;
    return this.defaultTariffIdFor(evseId) != null;
  }

  /**
   * E16.FR.15: checks the cost from CSMS (TransactionEventResponse.totalCost or
   * CostUpdatedRequest) against the cost limit. Returns true when the limit is reached now.
   */
  private async checkCentralCostLimit(evseId: number, txId: string): Promise<boolean> {
    if (this.usesLocalCostCalculation(evseId)) return false;
    if (this.evseLimitReached.get(evseId) ?? false) return false;
    const maxCost = this.pickMostRestrictive(
      this.evseTransactionLimits.get(evseId)?.maxCost,
      this.getDriverSetLimits()?.maxCost,
    );
    const totalCost = this.evseTotalCost.get(evseId);
    if (maxCost == null || totalCost == null || totalCost < maxCost) return false;
    this.evseLimitReached.set(evseId, true);
    await this.sendLimitReachedEvent(evseId, txId, 'CostLimitReached');
    return true;
  }

  /** Return the smaller of two optional limit values. */
  private pickMostRestrictive(a?: number, b?: number): number | undefined {
    if (a == null) return b;
    if (b == null) return a;
    return Math.min(a, b);
  }

  /** Get driver-set limits from configuration variables. */
  private getDriverSetLimits(): { maxEnergy?: number; maxTime?: number; maxCost?: number } | null {
    const maxEnergy = this.getConfigValue('TxCtrlr.MaxEnergyLimit');
    const maxTime = this.getConfigValue('TxCtrlr.MaxTimeLimit');
    const maxCost = this.getConfigValue('TxCtrlr.MaxCostLimit');
    if (maxEnergy == null && maxTime == null && maxCost == null) return null;
    const result: { maxEnergy?: number; maxTime?: number; maxCost?: number } = {};
    if (maxEnergy != null) result.maxEnergy = Number(maxEnergy);
    if (maxTime != null) result.maxTime = Number(maxTime);
    if (maxCost != null) result.maxCost = Number(maxCost);
    return result;
  }

  /**
   * Calculate local cost from the active tariff. Returns the running cost in currency units
   * or null if no tariff is configured.
   */
  private calculateLocalCost(evseId: number, gen: MeterValueGenerator): number | null {
    // Find applicable tariff for this EVSE
    let tariff: Record<string, unknown> | null = null;
    for (const entry of this.defaultTariffs.values()) {
      if (entry.evseId === 0 || entry.evseId === evseId) {
        tariff = entry.tariff;
        break;
      }
    }
    if (tariff == null) return null;

    const startTime = this.evseTransactionStartTime.get(evseId);
    if (startTime == null) return null;

    const elapsedMinutes = (Date.now() - startTime) / 60000;
    let cost = 0;

    // Calculate charging time cost
    const chargingTime = tariff['chargingTime'] as Record<string, unknown> | undefined;
    if (chargingTime != null) {
      const prices = chargingTime['prices'] as Array<Record<string, unknown>> | undefined;
      if (prices != null && prices.length > 0) {
        const firstPrice = prices[0];
        const pricePerMinute = (firstPrice?.['priceMinute'] as number | undefined) ?? 0;
        cost += pricePerMinute * elapsedMinutes;
      }
    }

    // Calculate energy cost
    const energy = tariff['energy'] as Record<string, unknown> | undefined;
    if (energy != null) {
      const prices = energy['prices'] as Array<Record<string, unknown>> | undefined;
      if (prices != null && prices.length > 0) {
        const firstEnergyPrice = prices[0];
        const pricePerKwh = (firstEnergyPrice?.['priceKwh'] as number | undefined) ?? 0;
        cost += pricePerKwh * (gen.energyWh / 1000);
      }
    }

    return cost;
  }

  /**
   * Send a TransactionEvent Updated with a limit-reached trigger reason.
   * Suspends the EVSE after sending.
   */
  private async sendLimitReachedEvent(
    evseId: number,
    txId: string,
    triggerReason: string,
  ): Promise<void> {
    // Change charging state to SuspendedEVSE
    this.evseChargingState.set(evseId, 'SuspendedEVSE');
    const connectorId = this.getConnectorId(evseId);
    await this.sendStatusNotification(evseId, connectorId, 'Occupied');

    const seqNo = (this.evseSeqNo.get(evseId) ?? 0) + 1;
    this.evseSeqNo.set(evseId, seqNo);
    await this.sendTransactionEvent(evseId, 'Updated', {
      triggerReason,
      transactionId: txId,
      chargingState: 'SuspendedEVSE',
      seqNo,
    });

    // Stop meter loop since charging is suspended
    this.stopMeterLoop(evseId);
  }

  // ---------------------------------------------------------------------------
  // Config helpers
  // ---------------------------------------------------------------------------

  private getConfigValue(key: string): string | undefined {
    return this.configVariables.get(key)?.value;
  }

  /** Set a config variable directly, bypassing read-only checks. For testing. */
  setConfigValue(key: string, value: string): void {
    const existing = this.configVariables.get(key);
    this.configVariables.set(key, { value, readonly: existing?.readonly ?? false });
    // Restart clock-aligned timer if interval changed
    if (
      key === 'AlignedDataCtrlr.Interval' ||
      key === 'AlignedDataCtrlr.Measurands' ||
      key === 'ClockAlignedDataInterval'
    ) {
      this.startClockAlignedTimer();
    }
    // Seed test transaction for OCTT tariff tests
    if (key === '_seedTestTransaction' && value === 'true') {
      this.activeTransactionIds.set(1, 'test-tx');
      this.transactionTariffCurrency.set('test-tx', 'EUR');
    }
  }

  /** Delete a config variable. For testing (e.g., simulating absent TxCtrlr.ResumptionTimeout). */
  deleteConfigValue(key: string): void {
    this.configVariables.delete(key);
  }

  private getSampledMeasurands(): string[] {
    if (this.is16) {
      const val = this.getConfigValue('MeterValuesSampledData') ?? '';
      return val.split(',').filter(Boolean);
    }
    const val = this.getConfigValue('SampledDataCtrlr.TxUpdatedMeasurands') ?? '';
    return val.split(',').filter(Boolean);
  }

  /** SampledDataCtrlr.TxEndedMeasurands (2.1), falling back to the TxUpdated set. */
  private getTxEndedMeasurands(): string[] {
    const val = this.getConfigValue('SampledDataCtrlr.TxEndedMeasurands');
    if (val == null) return this.getSampledMeasurands();
    return val.split(',').filter(Boolean);
  }

  /**
   * OCPP 2.1 J01.FR.21 / J02.FR.21: when SignReadings is true for the kind of
   * reading (AlignedDataCtrlr for Sample.Clock, SampledDataCtrlr otherwise),
   * every sampled value gets a signedMeterValue from the meter's signing unit.
   * publicKey follows OCPPCommCtrlr.PublicKeyWithSignedMeterValue: the key on
   * every value (EveryMeterValue), on the first of the transaction
   * (OncePerTransaction), or "" (Never).
   */
  private signMeterValue(
    evseId: number,
    meterValue: { timestamp: string; sampledValue: SampledValueRecord[] },
  ): { timestamp: string; sampledValue: SampledValueRecord[] } {
    if (this.is16) return meterValue;
    const aligned = meterValue.sampledValue[0]?.['context'] === 'Sample.Clock';
    const signKey = aligned ? 'AlignedDataCtrlr.SignReadings' : 'SampledDataCtrlr.SignReadings';
    if (this.getConfigValue(signKey) !== 'true') return meterValue;
    this.meterSigner ??= new OcmfMeterSigner({
      vendorName: this.config.vendorName,
      model: this.config.model,
      serialNumber: this.config.serialNumber,
      firmwareVersion: this.config.firmwareVersion,
    });
    const signer = this.meterSigner;
    const mode = this.getConfigValue('OCPPCommCtrlr.PublicKeyWithSignedMeterValue') ?? 'Never';
    return {
      ...meterValue,
      sampledValue: meterValue.sampledValue.map((sv) => {
        let includeKey = mode === 'EveryMeterValue';
        if (mode === 'OncePerTransaction' && !this.evsePublicKeySent.has(evseId)) {
          includeKey = true;
          this.evsePublicKeySent.add(evseId);
        }
        const unit = (sv['unitOfMeasure'] as { unit?: string } | undefined)?.unit;
        return {
          ...sv,
          signedMeterValue: signer.sign(
            {
              value: Number(sv['value']),
              measurand: sv['measurand'] as string | undefined,
              unit,
            },
            meterValue.timestamp,
            (sv['context'] as string | undefined) ?? 'Sample.Periodic',
            includeKey,
          ),
        };
      }),
    };
  }

  /**
   * Collect meter data for the TransactionEvent Ended while the transaction
   * runs: a Sample.Periodic reading every SampledDataCtrlr.TxEndedInterval and
   * a Sample.Clock reading at every AlignedDataCtrlr.TxEndedInterval boundary
   * (0 disables either). Readings use the matching TxEndedMeasurands.
   */
  private startTxEndedSampling(evseId: number, transactionId: string): void {
    this.stopTxEndedSampling(evseId);
    if (this.is16) return;
    this.evseTxEndedMeterValues.set(evseId, []);
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    this.txEndedTimers.set(evseId, timers);
    const record = (context: 'Sample.Periodic' | 'Sample.Clock', timestamp: Date): void => {
      if (this.evseContexts.get(evseId)?.transactionId !== transactionId) return;
      const gen = this.meterGens.get(evseId);
      if (gen == null) return;
      const measurandKey =
        context === 'Sample.Clock'
          ? 'AlignedDataCtrlr.TxEndedMeasurands'
          : 'SampledDataCtrlr.TxEndedMeasurands';
      const measurands = (this.getConfigValue(measurandKey) ?? '').split(',').filter(Boolean);
      const sampledValue = gen.generate(measurands, false).map((sv) => ({ ...sv, context }));
      if (sampledValue.length === 0) return;
      this.evseTxEndedMeterValues
        .get(evseId)
        ?.push({ timestamp: timestamp.toISOString(), sampledValue });
    };
    const sampledS = Number(this.getConfigValue('SampledDataCtrlr.TxEndedInterval') ?? '0');
    if (Number.isFinite(sampledS) && sampledS > 0) {
      timers.push(
        setInterval(() => {
          record('Sample.Periodic', new Date());
        }, sampledS * 1000),
      );
    }
    const alignedS = Number(this.getConfigValue('AlignedDataCtrlr.TxEndedInterval') ?? '0');
    if (Number.isFinite(alignedS) && alignedS > 0) {
      const ms = alignedS * 1000;
      const next = Math.ceil(Date.now() / ms) * ms;
      timers.push(
        setTimeout(() => {
          record('Sample.Clock', new Date(next));
          let boundary = next;
          timers.push(
            setInterval(() => {
              boundary += ms;
              record('Sample.Clock', new Date(boundary));
            }, ms),
          );
        }, next - Date.now()),
      );
    }
  }

  private stopTxEndedSampling(evseId: number): void {
    for (const timer of this.txEndedTimers.get(evseId) ?? []) clearTimeout(timer);
    this.txEndedTimers.delete(evseId);
  }

  private getSampledIntervalMs(): number {
    if (this.is16) {
      const secs = Number(this.getConfigValue('MeterValueSampleInterval') ?? '10');
      return (isNaN(secs) || secs <= 0 ? 10 : secs) * 1000;
    }
    const secs = Number(this.getConfigValue('SampledDataCtrlr.TxUpdatedInterval') ?? '10');
    return (isNaN(secs) || secs <= 0 ? 10 : secs) * 1000;
  }

  private getAlignedMeasurands(): string[] {
    if (this.is16) {
      const val = this.getConfigValue('MeterValuesAlignedData') ?? '';
      return val.split(',').filter(Boolean);
    }
    const val = this.getConfigValue('AlignedDataCtrlr.Measurands') ?? '';
    return val.split(',').filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat().catch(() => {});
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // EVSE helpers
  // ---------------------------------------------------------------------------

  private getConnectorId(evseId: number): number {
    const evse = this.config.evses.find((e) => e.evseId === evseId);
    return evse?.connectorId ?? 1;
  }

  // Synchronous check using cached transaction ID for meter loop
  // We store per-EVSE txId in memory when startCharging/stopCharging is called
  private readonly activeTransactionIds = new Map<number, string>();

  private getActiveTransactionSync(evseId: number): string | null {
    return this.activeTransactionIds.get(evseId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // DB helpers
  // ---------------------------------------------------------------------------

  private async updateStationStatus(status: string): Promise<void> {
    // Keep the self-heal readiness signal in lockstep with the station's
    // lifecycle: ready while operational, not-ready while booting or down. This
    // single chokepoint covers every boot / reconnect / offline / reset path.
    if (status === 'available') this.setReady(true);
    else if (status === 'booting' || status === 'disconnected') this.setReady(false);
    try {
      await this.sql`
        UPDATE css_stations SET status = ${status}, updated_at = NOW()
        WHERE id = ${this.config.id}
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Failed to update station status: ${msg}`);
    }
  }

  private async updateEvseStatus(evseId: number, status: string): Promise<void> {
    try {
      await this.sql`
        UPDATE css_evses SET status = ${status}
        WHERE css_station_id = ${this.config.id} AND evse_id = ${evseId}
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Failed to update EVSE status: ${msg}`);
    }
  }

  private async loadConfigVariables(): Promise<void> {
    await this.configVariables.load();
    // Seeds every default on first boot. Stations provisioned before a
    // variable existed get it with its default (like a firmware update adding
    // a device model variable); stored values are never overwritten.
    this.seedDefaultConfigVariables();
    // Stations provisioned before these variables existed get them on boot.
    if (!this.is16 && !this.configVariables.has(CSS_STATUS_REPORTING_KEY)) {
      this.configVariables.set(CSS_STATUS_REPORTING_KEY, {
        value: CSS_STATUS_REPORTING_DEFAULT,
        readonly: false,
      });
    }
    if (!this.is16) {
      for (const d of cssSecurityCtrlrDefaults(this.config.vendorName)) {
        if (!this.configVariables.has(d.key)) {
          this.configVariables.set(d.key, { value: d.value, readonly: d.readonly });
        }
      }
    }
    await this.installedCertificatesCache.load();
    if (this.installedCertificatesCache.size === 0) {
      if (this.is16) {
        this.seedCertificates16();
      } else {
        this.seedDefaultCertificates();
      }
    }
    this.refreshTrustAnchors();
    // No factory charging profiles: a station leaves the factory without any,
    // so the composite schedule is the local limit until the CSMS sets one (K08).
    await this.chargingProfilesCache.load();
    await this.displayMessagesCache.load();
    await this.localAuthEntries.load();
    await this.variableMonitors.load();
    // Continue numbering after the stored monitors (hardwired ones use a high range).
    for (const mon of this.variableMonitors.values()) {
      if (!mon.isHardwired && mon.id > this.monitorIdCounter) this.monitorIdCounter = mon.id;
    }
    await this.customerDataStore.load();
    await this.authCache.load();
    await this.loadOfflineMessageQueue();
    await this.loadReservationsWithTimers();
    this.rebuildTokenGroupMap();
    await this.rebuildEvseContextsFromTransactions();
    await this.loadPreservedTransactions();
  }

  private async loadReservationsWithTimers(): Promise<void> {
    await this.reservations.load();
    const now = Date.now();
    const expired: number[] = [];
    for (const [id, r] of this.reservations) {
      const expiryMs = new Date(r.expiryDateTime).getTime() - now;
      if (expiryMs <= 0) {
        expired.push(id);
      } else {
        this.scheduleReservationExpiry(id, expiryMs);
      }
    }
    for (const id of expired) this.reservations.delete(id);
  }

  private scheduleReservationExpiry(reservationId: number, ms: number): void {
    this.clearReservationTimer(reservationId);
    const timer = setTimeout(
      () => {
        void this.handleReservationExpiry(reservationId).catch((err: unknown) => {
          console.warn(
            `[${this.config.stationId}] reservation expiry handler failed`,
            err instanceof Error ? err.message : String(err),
          );
        });
      },
      Math.max(ms, 0),
    );
    this.reservationTimers.set(reservationId, timer);
  }

  private clearReservationTimer(reservationId: number): void {
    const timer = this.reservationTimers.get(reservationId);
    if (timer != null) {
      clearTimeout(timer);
      this.reservationTimers.delete(reservationId);
    }
  }

  private async handleReservationExpiry(reservationId: number): Promise<void> {
    const res = this.reservations.get(reservationId);
    if (res == null) return;
    this.reservations.delete(reservationId);
    this.reservationTimers.delete(reservationId);
    console.log(`[${this.config.stationId}] Reservation ${String(reservationId)} expired`);
    if (res.evseId > 0) {
      this.evseConnectorStatus.set(res.evseId, 'Available');
    }
    await this.sendReservationStatusUpdate(reservationId, 'Expired').catch(() => {});
    if (res.evseId > 0) {
      await this.sendStatusNotification(
        res.evseId,
        this.getConnectorId(res.evseId),
        'Available',
      ).catch(() => {});
    }
  }

  private rebuildTokenGroupMap(): void {
    this.tokenGroupMap.clear();
    for (const [idToken, entry] of this.localAuthEntries) {
      const groupIdToken = entry['groupIdToken'];
      if (groupIdToken != null && typeof groupIdToken === 'object') {
        this.tokenGroupMap.set(idToken, groupIdToken as Record<string, unknown>);
      }
    }
  }

  private async rebuildEvseContextsFromTransactions(): Promise<void> {
    try {
      const rows = await this.sql<
        Array<{
          evse_id: number;
          transaction_id: string;
          id_token: string | null;
          token_type: string | null;
        }>
      >`
        SELECT evse_id, transaction_id, id_token, token_type
        FROM css_transactions
        WHERE css_station_id = ${this.config.id} AND status = 'active'
      `;
      for (const r of rows) {
        const ctx = this.evseContexts.get(r.evse_id);
        if (ctx == null) continue;
        ctx.transactionId = r.transaction_id;
        ctx.authorizedToken = r.id_token;
        ctx.authorizedTokenType = r.token_type;
        ctx.cablePlugged = true;
        ctx.state = 'Occupied';
        this.activeTransactionIds.set(r.evse_id, r.transaction_id);
        // Repopulate transactionStartTokens for any active transaction so
        // TransactionEvent Updated/Ended carry the right idToken on the
        // first post-boot send.
        if (r.id_token != null) {
          this.transactionStartTokens.set(r.transaction_id, {
            idToken: r.id_token,
            groupIdToken: this.tokenGroupMap.get(r.id_token) ?? null,
          });
        }
      }
    } catch (err: unknown) {
      console.warn(
        `[${this.config.stationId}] evseContexts rebuild failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async loadPreservedTransactions(): Promise<void> {
    try {
      const rows = await this.sql<
        Array<{
          evse_id: number;
          transaction_id: string;
          id_token: string | null;
          token_type: string | null;
          preserved_at: Date;
        }>
      >`
        SELECT evse_id, transaction_id, id_token, token_type, preserved_at
        FROM css_transactions
        WHERE css_station_id = ${this.config.id}
          AND preserved_at IS NOT NULL
          AND status = 'active'
      `;
      for (const r of rows) {
        this.preservedTransactions.set(r.evse_id, {
          transactionId: r.transaction_id,
          idToken: r.id_token ?? '',
          tokenType: r.token_type ?? 'ISO14443',
          powerLossTime: r.preserved_at.getTime(),
        });
      }
    } catch (err: unknown) {
      console.warn(
        `[${this.config.stationId}] preserved transactions load failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async loadOfflineMessageQueue(): Promise<void> {
    try {
      const rows = await this.sql<
        Array<{ id: string; action: string; payload: Record<string, unknown> }>
      >`
        SELECT id, action, payload FROM css_offline_messages
        WHERE css_station_id = ${this.config.id}
        ORDER BY queued_at ASC
      `;
      this.offlineMessageQueue = rows.map((r) => ({
        id: r.id,
        action: r.action,
        payload: r.payload,
      }));
    } catch (err: unknown) {
      console.warn(
        `[${this.config.stationId}] offline queue load failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private enqueueOfflineMessage(
    action: string,
    payload: Record<string, unknown>,
    localTransactionId?: string,
  ): void {
    const id = 'com_' + randomUUID().replace(/-/g, '').slice(0, 12);
    this.offlineMessageQueue.push({
      id,
      action,
      payload,
      ...(localTransactionId != null ? { localTransactionId } : {}),
    });
    void this.sql`
      INSERT INTO css_offline_messages (id, css_station_id, action, payload)
      VALUES (${id}, ${this.config.id}, ${action}, ${this.sql.json(payload as Parameters<postgres.Sql['json']>[0])})
    `.catch((err: unknown) => {
      console.warn(
        `[${this.config.stationId}] offline queue enqueue failed`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  private dequeueOfflineMessage():
    | { id: string; action: string; payload: Record<string, unknown> }
    | undefined {
    const item = this.offlineMessageQueue.shift();
    if (item == null) return undefined;
    void this.sql`
      DELETE FROM css_offline_messages
      WHERE css_station_id = ${this.config.id} AND id = ${item.id}
    `.catch((err: unknown) => {
      console.warn(
        `[${this.config.stationId}] offline queue dequeue failed`,
        err instanceof Error ? err.message : String(err),
      );
    });
    return item;
  }

  private seedDefaultCertificates(): void {
    const defaults = [
      {
        serial: '01',
        certificateType: 'CSMSRootCertificate',
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          issuerKeyHash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
          serialNumber: '01',
        },
      },
      {
        serial: '03',
        certificateType: 'V2GCertificateChain',
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
          issuerKeyHash: 'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1',
          serialNumber: '03',
        },
      },
      {
        serial: '04',
        certificateType: 'V2GRootCertificate',
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          issuerKeyHash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
          serialNumber: '04',
        },
      },
      {
        serial: '05',
        certificateType: 'MORootCertificate',
        certificateHashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
          issuerKeyHash: 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
          serialNumber: '05',
        },
      },
    ];
    for (const d of defaults) {
      this.installedCertificatesCache.set(d.serial, {
        certificateType: d.certificateType,
        certificateHashData: d.certificateHashData,
      });
    }
    // Factory ManufacturerRootCertificate: firmware signing certificates chain to it (L01).
    const manufacturerRoot = parseCertificateChain(CSS_MANUFACTURER_ROOT_CA_PEM)?.[0];
    if (manufacturerRoot != null) {
      const hashData = certificateHashData(manufacturerRoot, manufacturerRoot);
      this.installedCertificatesCache.set(hashData.serialNumber, {
        certificateType: 'ManufacturerRootCertificate',
        certificateHashData: { ...hashData },
        certificate: CSS_MANUFACTURER_ROOT_CA_PEM,
      });
    }
  }

  private seedDefaultConfigVariables(): void {
    const defaults = buildCssConfigDefaults({
      ocppProtocol: this.is16 ? 'ocpp1.6' : 'ocpp2.1',
      stationId: this.config.stationId,
      vendorName: this.config.vendorName,
      model: this.config.model,
      serialNumber: this.config.serialNumber,
      firmwareVersion: this.config.firmwareVersion,
      securityProfile: this.config.securityProfile,
      targetUrl: this.config.targetUrl,
      evses: this.config.evses.map((e) => ({
        evseId: e.evseId,
        connectorId: e.connectorId,
        connectorType: e.connectorType,
        maxPowerW: e.maxPowerW,
        phases: e.phases,
      })),
    });
    for (const d of defaults) {
      if (this.configVariables.has(d.key)) continue;
      this.configVariables.set(d.key, {
        value: this.config.configOverrides?.[d.key] ?? d.value,
        readonly: d.readonly,
      });
    }
    // WebPaymentsCtrlr.SharedSecret: a random value on first boot (2.1 Part 2, C25)
    const sharedSecretKey = 'WebPaymentsCtrlr.SharedSecret';
    if (!this.is16 && !this.configVariables.has(sharedSecretKey)) {
      this.configVariables.set(sharedSecretKey, {
        value: this.config.configOverrides?.[sharedSecretKey] ?? randomBytes(16).toString('hex'),
        readonly: false,
      });
    }
    // Test-tx transaction for OCTT tariff tests is seeded via
    // setConfigValue('_seedTestTransaction', 'true') from the test, not on every boot
  }

  private async getActiveTransaction(
    evseId: number,
  ): Promise<{ transactionId: string; meterStartWh: number; idToken: string } | null> {
    try {
      const rows = await this.sql`
        SELECT transaction_id, meter_start_wh, id_token FROM css_transactions
        WHERE css_station_id = ${this.config.id} AND evse_id = ${evseId} AND status = 'active'
        ORDER BY started_at DESC LIMIT 1
      `;
      const row = rows[0];
      if (row == null) return null;
      return {
        transactionId: row.transaction_id as string,
        meterStartWh: row.meter_start_wh as number,
        idToken: (row.id_token as string | null) ?? '',
      };
    } catch (err) {
      logger.warn(
        { err, stationId: this.config.stationId, evseId },
        'Load active transaction failed, none assumed',
      );
      return null;
    }
  }

  private async findEvseForTransaction(transactionId: string): Promise<number | null> {
    // Check in-memory map first. The DB row in css_transactions can be missing
    // (insert failure, FK skew after a manual css_stations rotation, etc.) but
    // the in-memory state is what drove the OCPP TransactionEvent the CSMS is
    // now trying to stop, so it is the authoritative answer here.
    for (const [evseId, txId] of this.activeTransactionIds) {
      if (txId === transactionId) return evseId;
    }
    try {
      const rows = await this.sql`
        SELECT evse_id FROM css_transactions
        WHERE css_station_id = ${this.config.id} AND transaction_id = ${transactionId} AND status = 'active'
        LIMIT 1
      `;
      const row = rows[0];
      if (row == null) return null;
      return row.evse_id as number;
    } catch (err) {
      logger.warn(
        { err, stationId: this.config.stationId, transactionId },
        'Load EVSE of the transaction failed, none assumed',
      );
      return null;
    }
  }

  private async hasAnyActiveTransaction(): Promise<boolean> {
    // Check in-memory context first (works even when DB is unavailable)
    for (const ctx of this.evseContexts.values()) {
      if (ctx.transactionId != null) return true;
    }
    try {
      const rows = await this.sql`
        SELECT 1 FROM css_transactions
        WHERE css_station_id = ${this.config.id} AND status = 'active'
        LIMIT 1
      `;
      return rows.length > 0;
    } catch (err) {
      logger.warn(
        { err, stationId: this.config.stationId },
        'Check for an active transaction failed, none assumed',
      );
      return false;
    }
  }

  private async createTransaction(
    evseId: number,
    txId: string,
    idToken: string,
    tokenType: string,
    meterStartWh: number,
  ): Promise<void> {
    // Track in memory for sync access
    this.activeTransactionIds.set(evseId, txId);

    // Mark default tariffs as in use for this transaction (OCPP 2.1 only)
    if (!this.is16) {
      for (const entry of this.defaultTariffs.values()) {
        if (entry.evseId === 0 || entry.evseId === evseId) {
          entry.inUse = true;
        }
      }
    }

    try {
      const txRowId = 'ctx_' + randomUUID().replace(/-/g, '').slice(0, 12);
      await this.sql`
        INSERT INTO css_transactions (id, css_station_id, evse_id, transaction_id, id_token, token_type, meter_start_wh, charging_state)
        VALUES (${txRowId}, ${this.config.id}, ${evseId}, ${txId}, ${idToken}, ${tokenType}, ${meterStartWh}, ${'EVConnected'})
        ON CONFLICT (css_station_id, transaction_id) DO NOTHING
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Failed to create transaction: ${msg}`);
    }
  }

  // Caller MUST supply all three fields. The tagged-template SQL can't
  // build a dynamic SET clause from an optional update map, so the column
  // list here is fixed and any missing field would silently overwrite the
  // stored value with the default. The earlier code accepted an `updates`
  // object with optional fields plus a dead sets/values pair that hinted
  // at partial-update intent — a misleading API that would land as a
  // data-loss bug the moment a second caller forgot a field.
  private async updateTransaction(
    txId: string,
    updates: {
      currentPowerW: number;
      chargingState: string | null;
      seqNo: number;
    },
  ): Promise<void> {
    try {
      await this.sql`
        UPDATE css_transactions
        SET current_power_w = ${updates.currentPowerW},
            charging_state = ${updates.chargingState},
            seq_no = ${updates.seqNo}
        WHERE css_station_id = ${this.config.id} AND transaction_id = ${txId} AND status = 'active'
      `;
    } catch (err) {
      logger.warn(
        { err, stationId: this.config.stationId, transactionId: txId },
        'Update of the stored transaction state failed',
      );
    }
  }

  private async completeTransaction(
    txId: string,
    reason: string,
    meterStopWh: number,
  ): Promise<void> {
    // Remove from memory cache
    for (const [evseId, id] of this.activeTransactionIds) {
      if (id === txId) {
        this.activeTransactionIds.delete(evseId);
        break;
      }
    }

    try {
      await this.sql`
        UPDATE css_transactions
        SET status = 'completed', stopped_at = NOW(), stopped_reason = ${reason}, meter_stop_wh = ${meterStopWh}, current_power_w = 0
        WHERE css_station_id = ${this.config.id} AND transaction_id = ${txId}
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.config.stationId}] Failed to complete transaction: ${msg}`);
    }
  }
}
