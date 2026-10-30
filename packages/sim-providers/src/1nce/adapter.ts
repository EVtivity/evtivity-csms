// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { iccidsMatch, normalizeIccid } from '@evtivity/lib/iccid';
import { isOneNceClientId } from '@evtivity/lib/sim-settings';
import type { SimProviderFactory } from '../registry.js';
import { SimProviderError } from '../types.js';
import type {
  SimAlert,
  SimCapabilities,
  SimConnectionResult,
  SimPage,
  SimProvider,
  SimRef,
  SimResetResult,
  SimSession,
  SimStatus,
  SimTimeRange,
  SimUsage,
} from '../types.js';
import { ONENCE_BASE_URL, OneNceClient } from './client.js';
import type { OneNceClientOptions, OneNceRequest } from './client.js';
import { pickEvents, pickQuota, pickSim, pickStatus, ratName } from './fields.js';
import type { OneNceEvent, OneNceSim } from './fields.js';
import { mapOneNceState, oneNceProviderState } from './states.js';

// Every assumption about a real 1NCE SIM sits in the constants below, so the
// live check of a real SIM (owner decision 2026-10-29, required before 1NCE
// ships in a release) can confirm or change each one. Confirmed on a real SIM
// (2026-10-30): the SIM, status, quota and events reply shapes, events newest
// first by time, event ids not in time order, a page past the last one
// answering the last page again, and the 20-digit ICCID answering 404.

/**
 * How far back sessions and alerts are read. The API retention is not
 * documented; the 1NCE Portal deletes logging data after 7 days. Unconfirmed:
 * the live SIM was younger than the window.
 */
export const ONENCE_HISTORY_DAYS = 7;
/**
 * Events are written by the network core; the Delete PDP Context event carries
 * the volume. Unconfirmed: the live SIM has not opened a data session yet.
 */
export const ONENCE_REPORTING_DELAY_HOURS = 1;
/** The largest events page the v2 API allows (live: 1001 answers 400). */
export const ONENCE_EVENT_PAGE_SIZE = 1000;
/** At most this many event pages per Refresh (10000 events, owner decision 2026-10-29). */
export const ONENCE_EVENT_PAGE_CAP = 10;
/**
 * Event type ids of the PDP context events, from the 1NCE v2 event type table
 * (Data Streamer event records: 3 Create, 4 Update, 5 Delete PDP Context). The
 * REST events carry the ids of that table (live: 56 Data Quota Assigned, 58
 * SMS Quota Assigned). The v2 REST spec example pairs 4 with "Delete PDP
 * Context", so the event description decides when it names a PDP event
 * (`pdpEventKind`); the ids decide only without one. No PDP event has been
 * seen on a real SIM yet.
 */
export const ONENCE_PDP_EVENT_TYPES = Object.freeze({ create: 3, delete: 5 });
/**
 * The network name, radio type and cell id of a session come from event
 * fields no real SIM has shown yet (owner decision 2026-10-29: hidden until
 * the live check proves them). True turns the three capabilities and fields on.
 */
export const ONENCE_SESSION_DETAIL_FIELDS = false;
// One Refresh reads the SIM and its events once for the status, sessions and alerts.
const READ_MEMO_MS = 30_000;
const BYTES_PER_MB = 1024 * 1024;
// The end time and event id are padded in the session id, so the ids of one SIM
// compare as text in time order (1NCE event ids are not in time order).
const EVENT_ID_DIGITS = 19;
const TIME_MS_DIGITS = 13;

const PDP_EVENT_NAME = /^(create|update|delete) pdp context$/i;

/**
 * Whether an event opens or closes a data session: the description when it
 * names a PDP context event, else the type id of the 1NCE event type table.
 */
export function pdpEventKind(event: {
  typeId: number | null;
  typeName: string | null;
}): 'create' | 'delete' | null {
  const named = PDP_EVENT_NAME.exec(event.typeName?.trim() ?? '');
  if (named != null) {
    const verb = (named[1] ?? '').toLowerCase();
    return verb === 'create' ? 'create' : verb === 'delete' ? 'delete' : null;
  }
  if (event.typeId === ONENCE_PDP_EVENT_TYPES.create) return 'create';
  if (event.typeId === ONENCE_PDP_EVENT_TYPES.delete) return 'delete';
  return null;
}

function capabilities(sessionDetailFields: boolean): SimCapabilities {
  return {
    networkName: sessionDetailFields,
    radioAccessTechnology: sessionDetailFields,
    cellId: sessionDetailFields,
    usage: true,
    sessions: true,
    alerts: true,
    networkReset: true,
  };
}

/** True when the 1NCE settings can build an adapter: on, a valid client id and a secret. */
export function oneNceConfigured(settings: {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
}): boolean {
  // A malformed client id counts as not configured; the settings route refuses to save one.
  return (
    settings.enabled && settings.clientSecret.trim() !== '' && isOneNceClientId(settings.clientId)
  );
}

/** True when the last digit of a 20-digit ICCID is the Luhn check digit of the first 19. */
export function hasLuhnCheckDigit(iccid: string): boolean {
  if (!/^\d{20}$/.test(iccid)) return false;
  let sum = 0;
  for (let i = 0; i < 19; i += 1) {
    // Doubling starts at the digit next to the check digit.
    let digit = Number(iccid[18 - i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10 === Number(iccid[19]);
}

/** The ICCID a stored ref names, refused before any request unless it is 19 or 20 digits. */
function refIccid(ref: SimRef): string {
  if (!/^\d{19,20}$/.test(ref.providerSimId)) {
    throw new SimProviderError('not_found', 'The SIM match has no usable 1NCE ICCID');
  }
  return ref.providerSimId;
}

function sessionId(iccid: string, event: OneNceEvent): string {
  const at = String(Date.parse(event.timestamp)).padStart(TIME_MS_DIGITS, '0');
  return `${iccid}:${at}:${String(event.id).padStart(EVENT_ID_DIGITS, '0')}`;
}

function inRange(at: string, range: SimTimeRange | undefined): boolean {
  if (range == null) return true;
  const time = Date.parse(at);
  return time >= range.from.getTime() && time <= range.to.getTime();
}

/** Newest first by time, then by event id (1NCE event ids are not in time order). */
function newestFirst(events: readonly OneNceEvent[]): OneNceEvent[] {
  // Picked timestamps are ISO 8601 UTC with milliseconds, so they compare as text.
  return [...events].sort((a, b) =>
    a.timestamp === b.timestamp ? b.id - a.id : a.timestamp < b.timestamp ? 1 : -1,
  );
}

function headerInt(headers: Headers, name: string): number | null {
  const value = headers.get(name)?.trim() ?? '';
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}

interface EventRead {
  events: OneNceEvent[];
  /** Set when the page cap ended the read before the range start. */
  coveredFrom: string | null;
}

interface Memo<T> {
  at: number;
  value: Promise<T>;
}

export interface OneNceProviderOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Defaults to ONENCE_SESSION_DETAIL_FIELDS. */
  sessionDetailFields?: boolean;
}

export class OneNceProvider implements SimProvider {
  readonly id = '1nce' as const;
  readonly capabilities: SimCapabilities;
  readonly historyDays = ONENCE_HISTORY_DAYS;
  readonly reportingDelayHours = ONENCE_REPORTING_DELAY_HOURS;
  private readonly client: OneNceClient;
  private readonly sessionDetailFields: boolean;
  private readonly simReads = new Map<string, Memo<OneNceSim>>();
  private readonly eventReads = new Map<string, Memo<EventRead>>();

  constructor(options: OneNceProviderOptions) {
    const clientOptions: OneNceClientOptions = {
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      baseUrl: options.baseUrl ?? ONENCE_BASE_URL,
    };
    if (options.fetch != null) clientOptions.fetch = options.fetch;
    if (options.timeoutMs != null) clientOptions.timeoutMs = options.timeoutMs;
    this.client = new OneNceClient(clientOptions);
    this.sessionDetailFields = options.sessionDetailFields ?? ONENCE_SESSION_DETAIL_FIELDS;
    this.capabilities = capabilities(this.sessionDetailFields);
  }

  async findByIccid(iccid: string): Promise<SimRef | null> {
    const wanted = normalizeIccid(iccid);
    if (wanted == null) throw new SimProviderError('not_found', 'The ICCID is not valid');
    // 1NCE keys SIMs by the 19-digit ICCID and answers 404 for the 20-digit
    // form with its Luhn check digit (live), which a station often reports;
    // its replies hold no `iccid_with_luhn`. So that form asks for the 19
    // digits first.
    const tries = hasLuhnCheckDigit(wanted) ? [wanted.slice(0, 19), wanted] : [wanted];
    for (const candidate of tries) {
      let sim: OneNceSim;
      try {
        sim = await this.fetchSim(candidate);
      } catch (err: unknown) {
        if (err instanceof SimProviderError && err.kind === 'not_found') continue;
        throw err;
      }
      const matches = iccidsMatch(sim.iccid, candidate) || iccidsMatch(sim.iccidWithLuhn, wanted);
      if (matches && sim.iccid != null && /^\d{19,20}$/.test(sim.iccid)) {
        return { providerSimId: sim.iccid };
      }
    }
    return null;
  }

  async getStatus(ref: SimRef): Promise<SimStatus> {
    const iccid = refIccid(ref);
    // In sequence: the account shares one limit of 10 requests a second.
    const sim = await this.readSim(iccid, { fresh: true });
    const connectivity = pickStatus(
      (
        await this.request({
          method: 'GET',
          path: `/v2/sims/${iccid}/status`,
          label: '/v2/sims/{iccid}/status',
        })
      ).body,
    );
    let usage: SimUsage | null = null;
    try {
      const quota = pickQuota(
        (
          await this.request({
            method: 'GET',
            path: `/v2/sims/${iccid}/quota/data`,
            label: '/v2/sims/{iccid}/quota/data',
          })
        ).body,
      );
      if (quota?.totalVolume != null && quota.volume != null) {
        usage = {
          bytes: Math.max(0, Math.round((quota.totalVolume - quota.volume) * BYTES_PER_MB)),
          periodEnd: quota.expiresAt,
          limitBytes: Math.round(quota.totalVolume * BYTES_PER_MB),
        };
      }
    } catch (err: unknown) {
      // A SIM without a data quota still has a status, just without usage.
      if (!(err instanceof SimProviderError && err.kind === 'not_found')) throw err;
    }
    const open = [...(connectivity?.openContexts ?? [])].sort((a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
    )[0];
    const linkState = connectivity?.status ?? null;
    return {
      providerSimId: iccid,
      iccid: sim.iccidWithLuhn ?? sim.iccid ?? iccid,
      imsi: sim.imsi,
      state: mapOneNceState(sim.status, linkState),
      providerState: oneNceProviderState(sim.status, linkState),
      inSession:
        connectivity == null
          ? null
          : connectivity.openContexts.length > 0 || connectivity.status === 'ONLINE',
      openSessionBeganAt: open?.createdAt ?? null,
      apn: open?.apn ?? null,
      profileName: null,
      lastSessionAt: null,
      usage,
    };
  }

  async listSessions(
    ref: SimRef,
    page: { startAfter?: string; range?: SimTimeRange },
  ): Promise<SimPage<SimSession>> {
    const iccid = refIccid(ref);
    const read = await this.readEvents(iccid, page.range, { fresh: true });
    const events = newestFirst(read.events);
    // Each Delete with the latest earlier Create of the same context, walked oldest first.
    const deletes: { event: OneNceEvent; create: OneNceEvent | undefined }[] = [];
    const lastCreate = new Map<string, OneNceEvent>();
    for (const event of [...events].reverse()) {
      if (event.pdpContextId == null) continue;
      const kind = pdpEventKind(event);
      if (kind === 'create') lastCreate.set(event.pdpContextId, event);
      if (kind === 'delete') deletes.push({ event, create: lastCreate.get(event.pdpContextId) });
    }
    const items: SimSession[] = [];
    for (const { event, create } of deletes.reverse()) {
      const id = sessionId(iccid, event);
      if (page.startAfter != null && id >= page.startAfter) continue;
      if (!inRange(event.timestamp, page.range)) continue;
      const startedAt = create?.timestamp ?? event.tunnelCreatedAt ?? event.timestamp;
      const detail = this.sessionDetailFields;
      items.push({
        providerSessionId: id,
        startedAt: startedAt <= event.timestamp ? startedAt : event.timestamp,
        endedAt: event.timestamp,
        bytes: event.volumeTotal == null ? null : Math.round(event.volumeTotal * BYTES_PER_MB),
        networkName: detail ? (create?.networkName ?? event.networkName) : null,
        radioAccessTechnology: detail ? ratName(create?.ratType ?? event.ratType) : null,
        cellId: detail ? (create?.cellId ?? event.cellId) : null,
        apn: event.apn ?? create?.apn ?? null,
      });
    }
    const last = items.at(-1);
    const result: SimPage<SimSession> = {
      items,
      continues: false,
      lastId: last?.providerSessionId ?? null,
    };
    if (read.coveredFrom != null) result.coveredFrom = read.coveredFrom;
    return result;
  }

  /**
   * 1NCE has no alert feed: the data alerts come from the SIM's quota status
   * dates, a device change from two events in a row naming different devices
   * (compared as hashes in memory; no device identifier is returned or kept).
   */
  async listAlerts(
    ref: SimRef,
    page: { startAfter?: string; range: SimTimeRange },
  ): Promise<SimPage<SimAlert>> {
    const iccid = refIccid(ref);
    const sim = await this.readSim(iccid);
    const read = await this.readEvents(iccid, page.range);
    const items: SimAlert[] = [];
    const quotaAlert = (kind: 'data_warning' | 'data_limit', code: string, time: string | null) => {
      if (time == null || !inRange(time, page.range)) return;
      const seconds = Math.floor(Date.parse(time) / 1000);
      items.push({
        providerAlertId: `${iccid}:${code}:${String(seconds)}`,
        kind,
        receivedAt: time,
      });
    };
    quotaAlert('data_limit', 'dl', sim.quotaExceededAt);
    quotaAlert('data_warning', 'dw', sim.thresholdReachedAt);
    const oldestFirst = newestFirst(read.events).reverse();
    let previous: string | null = null;
    for (const event of oldestFirst) {
      if (event.deviceHash == null) continue;
      if (
        previous != null &&
        previous !== event.deviceHash &&
        inRange(event.timestamp, page.range)
      ) {
        items.push({
          providerAlertId: `${iccid}:dc:${String(event.id)}`,
          kind: 'device_changed',
          receivedAt: event.timestamp,
        });
      }
      previous = event.deviceHash;
    }
    items.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return { items, continues: false, lastId: null };
  }

  /**
   * 1NCE queues the reset ("a positive response only means that the
   * connectivity reset has been successfully placed into the queue"), so the
   * result is `submitted`; nothing confirms it ran.
   */
  async resetNetwork(ref: SimRef): Promise<SimResetResult> {
    const iccid = refIccid(ref);
    try {
      await this.request({
        method: 'POST',
        path: `/v2/sims/${iccid}/reset`,
        label: '/v2/sims/{iccid}/reset',
        badRequest: 'unsupported',
      });
    } catch (err: unknown) {
      if (err instanceof SimProviderError && err.kind === 'unsupported') {
        // 400 and 409: the provider's text is never copied.
        throw new SimProviderError('unsupported', '1NCE refused the network reset', {
          cause: err,
        });
      }
      throw err;
    }
    return { status: 'submitted' };
  }

  /** The SIM count of the account; 1NCE has no organizations. */
  async testConnection(): Promise<SimConnectionResult> {
    const reply = await this.request({
      method: 'GET',
      path: '/v2/sims',
      label: '/v2/sims',
      query: { page: 1, pageSize: 1 },
    });
    const header = reply.headers.get('x-total-count')?.trim() ?? '';
    const count = /^\d{1,15}$/.test(header) ? Number(header) : Number.NaN;
    if (!Number.isSafeInteger(count)) {
      throw new SimProviderError('unavailable', '1NCE answered the SIM list without a count');
    }
    return { deviceCount: count, otherOrganizations: [] };
  }

  private async request(req: OneNceRequest) {
    return this.client.request(req);
  }

  private async fetchSim(iccid: string): Promise<OneNceSim> {
    const sim = pickSim(
      (
        await this.request({
          method: 'GET',
          path: `/v2/sims/${iccid}`,
          label: '/v2/sims/{iccid}',
          // 1NCE answers a malformed ICCID like an unknown one.
          badRequest: 'not_found',
        })
      ).body,
    );
    if (sim == null) throw new SimProviderError('unavailable', '1NCE returned no SIM');
    return sim;
  }

  /**
   * The SIM, read once per Refresh: the status reads it fresh, the alerts that
   * follow in the same Refresh reuse that read.
   */
  private readSim(iccid: string, options: { fresh?: boolean } = {}): Promise<OneNceSim> {
    return this.memo(this.simReads, iccid, () => this.fetchSim(iccid), options);
  }

  /**
   * The SIM's events of the range, read once per Refresh: the sessions read
   * them fresh, the alerts that follow in the same Refresh reuse that read.
   */
  private readEvents(
    iccid: string,
    range: SimTimeRange | undefined,
    options: { fresh?: boolean } = {},
  ): Promise<EventRead> {
    const key = `${iccid}|${String(range?.from.getTime())}|${String(range?.to.getTime())}`;
    return this.memo(this.eventReads, key, () => this.fetchEvents(iccid, range), options);
  }

  private async fetchEvents(iccid: string, range: SimTimeRange | undefined): Promise<EventRead> {
    // By event id: a page boundary can move while the pages are read, and 1NCE
    // may send an event again (a repeated id is a retransmission).
    const byId = new Map<number, OneNceEvent>();
    const events = (): OneNceEvent[] => [...byId.values()];
    let oldest: string | null = null;
    // The v2 events route has no time filter; it answers newest first by time
    // (live). Read pages until the last page, a page reaching before the
    // range, or the page cap.
    for (let page = 1; page <= ONENCE_EVENT_PAGE_CAP; page += 1) {
      const reply = await this.request({
        method: 'GET',
        path: `/v2/sims/${iccid}/events`,
        label: '/v2/sims/{iccid}/events',
        query: { page, pageSize: ONENCE_EVENT_PAGE_SIZE },
        badRequest: 'unavailable',
      });
      // A page past the last one answers the last page again (live), with
      // `X-Current-Page` naming the page it holds.
      const current = headerInt(reply.headers, 'x-current-page');
      if (current != null && current !== page) return { events: events(), coveredFrom: null };
      const { events: read, read: count } = pickEvents(reply.body);
      for (const event of read) {
        byId.set(event.id, event);
        if (oldest == null || event.timestamp < oldest) oldest = event.timestamp;
      }
      const pages = headerInt(reply.headers, 'x-total-pages');
      if (count < ONENCE_EVENT_PAGE_SIZE || (pages != null && page >= pages)) {
        return { events: events(), coveredFrom: null };
      }
      if (range != null && oldest != null && Date.parse(oldest) < range.from.getTime()) {
        return { events: events(), coveredFrom: null };
      }
    }
    // The cap ended the read: the period is covered only from the oldest event read.
    const reachedStart =
      range == null || (oldest != null && Date.parse(oldest) <= range.from.getTime());
    return {
      events: events(),
      coveredFrom: reachedStart ? null : (oldest ?? new Date().toISOString()),
    };
  }

  private memo<T>(
    store: Map<string, Memo<T>>,
    key: string,
    load: () => Promise<T>,
    options: { fresh?: boolean },
  ): Promise<T> {
    const now = Date.now();
    for (const [k, entry] of store) if (now - entry.at >= READ_MEMO_MS) store.delete(k);
    const cached = options.fresh === true ? undefined : store.get(key);
    if (cached != null) return cached.value;
    const value = load();
    store.set(key, { at: now, value });
    // A failed read is not kept: the next call asks again.
    value.catch(() => {
      if (store.get(key)?.value === value) store.delete(key);
    });
    return value;
  }
}

export const oneNceFactory: SimProviderFactory = {
  id: '1nce',
  create(settings, options) {
    if (!oneNceConfigured(settings['1nce'])) return null;
    return new OneNceProvider({
      clientId: settings['1nce'].clientId.trim(),
      clientSecret: settings['1nce'].clientSecret.trim(),
      baseUrl:
        options.testBaseUrl == null
          ? ONENCE_BASE_URL
          : `${options.testBaseUrl}/1nce/management-api`,
    });
  },
};
