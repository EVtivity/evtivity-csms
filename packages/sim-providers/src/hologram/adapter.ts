// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { iccidsMatch, normalizeIccid } from '@evtivity/lib/iccid';
import { isHologramOrgId } from '@evtivity/lib/sim-settings';
import type { SimProviderFactory } from '../registry.js';
import { SimProviderError } from '../types.js';
import type {
  SimAlert,
  SimAlertKind,
  SimCapabilities,
  SimConnectionResult,
  SimOrganizationCount,
  SimPage,
  SimProvider,
  SimRef,
  SimResetResult,
  SimSession,
  SimStatus,
  SimTimeRange,
  SimUsage,
} from '../types.js';
import { HOLOGRAM_BASE_URL, HologramClient, HologramRequestError } from './client.js';
import type { HologramClientOptions } from './client.js';
import {
  pickBillingUsage,
  pickCsrRecord,
  pickData,
  pickDevice,
  pickListPage,
  pickOrganization,
  pickUsageRecord,
} from './fields.js';
import type {
  HologramBillingUsage,
  HologramDevice,
  HologramLink,
  HologramOrganization,
} from './fields.js';
import { HOLOGRAM_RESET_STATES, mapHologramState } from './states.js';

// About 3 months is documented for billing usage only; the live check confirms
// the window of sessions and CSR records once a SIM has history.
export const HOLOGRAM_HISTORY_DAYS = 90;
// Sessions are reported after they close: every 2 h on USA-2, every 6 h on
// USA-1 and no stated interval on the global profiles, so 6 h for all.
export const HOLOGRAM_REPORTING_DELAY_HOURS = 6;
export const HOLOGRAM_SESSION_PAGE_LIMIT = 5000;
// The spec sets no maximum for /csr/data (its other list calls allow 1000 to
// 5000); alerts are rare, so 1000 a page keeps one page per fetch.
export const HOLOGRAM_ALERT_PAGE_LIMIT = 1000;
/** How many other organizations Test Connection counts SIMs in. */
export const HOLOGRAM_ORGANIZATION_SCAN_LIMIT = 10;

// The network reset refusals Hologram documents, shown as fixed text: the
// provider's own text is never copied into an error.
const HOLOGRAM_RESET_REFUSALS: Readonly<Record<string, string>> = {
  'Some links are not able to update location due to their current network state':
    'the SIM network state does not allow it',
  'Some links are not able to update location due to carrier limitations':
    'the carrier does not support it',
  'There were invalid links': 'the SIM link is not in this organization',
};

/** The system topics of the CSR records that carry SIM alerts. */
export const HOLOGRAM_ALERT_TOPICS: Readonly<Record<string, SimAlertKind>> = {
  _DATALIMIT_: 'data_limit',
  _DATAWARNING_: 'data_warning',
  _IMEI_CHANGE_: 'device_changed',
  _IMEI_TAC_CHANGE_: 'device_model_changed',
  _IMEI_FIRST_: 'first_device',
};

const CAPABILITIES: SimCapabilities = {
  networkName: true,
  radioAccessTechnology: true,
  cellId: true,
  usage: true,
  sessions: true,
  alerts: true,
  networkReset: true,
};

// Hologram times are `YYYY-MM-DD HH:mm:ss` in UTC without a zone.
const HOLOGRAM_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/;

export function hologramTimeToIso(value: string | null): string | null {
  if (value == null) return null;
  const match = HOLOGRAM_TIME.exec(value.trim());
  if (match == null) return null;
  const at = Date.parse(`${match[1] ?? ''}T${match[2] ?? ''}${match[3] ?? 'Z'}`);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function numericId(value: string | undefined, name: string): number {
  if (value == null || !/^\d{1,15}$/.test(value)) {
    throw new SimProviderError('not_found', `The SIM match has no usable ${name}`);
  }
  return Number(value);
}

function findLink(device: HologramDevice, linkId: string | undefined): HologramLink | null {
  if (linkId == null) return null;
  return device.links.find((l) => String(l.id) === linkId) ?? null;
}

function continuedPage<T>(items: T[], continues: boolean, lastId: number | null): SimPage<T> {
  // A page that says it continues without a cursor cannot be followed, so paging ends there.
  return {
    items,
    continues: continues && lastId != null,
    lastId: lastId == null ? null : String(lastId),
  };
}

function limitBytes(device: HologramDevice, link: HologramLink): number | null {
  const planData = link.planData ?? device.intendedPlanData;
  const overage = link.overageLimit;
  // -1 means unlimited overage, so there is no limit to warn about.
  if (planData == null || overage == null || overage < 0) return null;
  return planData + overage;
}

function newestSessionEnd(usage: HologramBillingUsage, link: HologramLink): string | null {
  let newest: string | null = null;
  for (const session of usage.recentSessions) {
    if (session.linkId !== link.id) continue;
    const at = hologramTimeToIso(session.end ?? session.begin);
    if (at != null && (newest == null || at > newest)) newest = at;
  }
  return newest;
}

export interface HologramProviderOptions {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HologramProvider implements SimProvider {
  readonly id = 'hologram' as const;
  readonly capabilities = CAPABILITIES;
  readonly historyDays = HOLOGRAM_HISTORY_DAYS;
  readonly reportingDelayHours = HOLOGRAM_REPORTING_DELAY_HOURS;
  private readonly client: HologramClient;
  private readonly orgId: string;

  constructor(options: HologramProviderOptions) {
    const clientOptions: HologramClientOptions = {
      apiKey: options.apiKey,
      orgId: options.orgId,
      baseUrl: options.baseUrl ?? HOLOGRAM_BASE_URL,
    };
    if (options.fetch != null) clientOptions.fetch = options.fetch;
    if (options.timeoutMs != null) clientOptions.timeoutMs = options.timeoutMs;
    this.client = new HologramClient(clientOptions);
    this.orgId = options.orgId;
  }

  async findByIccid(iccid: string): Promise<SimRef | null> {
    const wanted = normalizeIccid(iccid);
    if (wanted == null) throw new SimProviderError('not_found', 'The ICCID is not valid');
    const page = pickListPage(
      await this.client.request({
        method: 'GET',
        path: '/devices',
        label: '/devices',
        query: { iccid: wanted },
      }),
    );
    for (const device of page.data.map(pickDevice)) {
      const link = device?.links.find((l) => iccidsMatch(l.iccid, wanted));
      if (device == null || link == null) continue;
      const ref: SimRef = { providerSimId: String(device.id), linkId: String(link.id) };
      const simcardId = link.simcardId ?? device.simcardId;
      if (simcardId != null) ref.simcardId = String(simcardId);
      return ref;
    }
    return null;
  }

  async getStatus(ref: SimRef): Promise<SimStatus> {
    const device = await this.getDevice(ref);
    // A profile switch can replace the link; the status then shows the device's current one.
    const link = findLink(device, ref.linkId) ?? device.links[0];
    if (link == null) {
      throw new SimProviderError('not_found', 'The Hologram device has no cellular link');
    }
    const simcardId = ref.simcardId ?? device.simcardId ?? link.simcardId ?? undefined;
    const billing = simcardId == null ? null : await this.getBillingUsage(String(simcardId));
    const openSession = billing?.openSessions.find((s) => s.linkId === link.id) ?? null;
    let usage: SimUsage | null = null;
    if (billing?.bytes != null) {
      usage = {
        bytes: billing.bytes,
        periodEnd: hologramTimeToIso(billing.periodEnd),
        limitBytes: limitBytes(device, link),
      };
    }
    return {
      providerSimId: String(device.id),
      iccid: link.iccid ?? '',
      imsi: link.imsi,
      state: mapHologramState(link.state),
      providerState: link.state ?? '',
      inSession: billing == null ? null : openSession != null,
      openSessionBeganAt: hologramTimeToIso(openSession?.begin ?? null),
      apn: link.apn,
      profileName: link.profileName,
      lastSessionAt: billing == null ? null : newestSessionEnd(billing, link),
      usage,
    };
  }

  async listSessions(
    ref: SimRef,
    page: { startAfter?: string; range?: SimTimeRange },
  ): Promise<SimPage<SimSession>> {
    const linkId = numericId(ref.linkId, 'link id');
    // getlocationinfo is never sent: the CSMS keeps no location from Hologram.
    const raw = await this.client.request({
      method: 'GET',
      path: '/usage/data/',
      label: '/usage/data/',
      query: {
        linkid: linkId,
        limit: HOLOGRAM_SESSION_PAGE_LIMIT,
        startafter: page.startAfter,
        timestart: page.range == null ? undefined : unixSeconds(page.range.from),
        timeend: page.range == null ? undefined : unixSeconds(page.range.to),
      },
    });
    const list = pickListPage(raw);
    const records = list.data.map(pickUsageRecord).filter((r) => r != null);
    const items: SimSession[] = [];
    for (const record of records) {
      const startedAt = hologramTimeToIso(record.begin);
      const endedAt = hologramTimeToIso(record.end);
      if (startedAt == null || endedAt == null) continue;
      items.push({
        providerSessionId: String(record.recordId),
        startedAt,
        endedAt,
        bytes: record.bytes,
        networkName: record.networkName,
        radioAccessTechnology: record.radioAccessTechnology,
        cellId: record.cellId == null ? null : String(record.cellId),
        apn: null,
      });
    }
    return continuedPage(items, list.continues, list.lastId);
  }

  async listAlerts(
    ref: SimRef,
    page: { startAfter?: string; range: SimTimeRange },
  ): Promise<SimPage<SimAlert>> {
    const deviceId = numericId(ref.providerSimId, 'device id');
    const raw = await this.client.request({
      method: 'GET',
      path: '/csr/data',
      label: '/csr/data',
      query: {
        deviceid: deviceId,
        limit: HOLOGRAM_ALERT_PAGE_LIMIT,
        topicnames: Object.keys(HOLOGRAM_ALERT_TOPICS).join(','),
        timestart: unixSeconds(page.range.from),
        timeend: unixSeconds(page.range.to),
        startafter: page.startAfter,
      },
    });
    const list = pickListPage(raw);
    const records = list.data.map(pickCsrRecord).filter((r) => r != null);
    const items: SimAlert[] = [];
    for (const record of records) {
      const topic = record.topics.find((t) => Object.hasOwn(HOLOGRAM_ALERT_TOPICS, t));
      const receivedAt = hologramTimeToIso(record.logged);
      const kind = topic == null ? undefined : HOLOGRAM_ALERT_TOPICS[topic];
      if (kind == null || receivedAt == null) continue;
      items.push({ providerAlertId: String(record.id), kind, receivedAt });
    }
    return continuedPage(items, list.continues, list.lastId);
  }

  async resetNetwork(ref: SimRef): Promise<SimResetResult> {
    numericId(ref.linkId, 'link id');
    const device = await this.getDevice(ref);
    // Reset only the matched link: a link the device no longer has means the match is stale.
    const link = findLink(device, ref.linkId);
    if (link == null) {
      throw new SimProviderError('not_found', 'The matched SIM link is no longer on the device');
    }
    if (link.state == null || !HOLOGRAM_RESET_STATES.has(link.state)) {
      throw new SimProviderError(
        'unsupported',
        `Hologram resets only a SIM in LIVE, TEST-ACTIVATE or TEST-AUTOACTIVATE, not ${link.state ?? 'an unknown state'}`,
      );
    }
    const body = { linkids: [link.id] };
    // The preview runs every check without updating, so a refused SIM changes nothing.
    await this.updateLocation(body, true);
    await this.updateLocation(body, false);
    return { status: 'accepted' };
  }

  async testConnection(): Promise<SimConnectionResult> {
    await this.client.request({
      method: 'GET',
      path: `/organizations/${encodeURIComponent(this.orgId)}`,
      label: '/organizations/{orgId}',
      badRequest: 'not_found',
    });
    const deviceCount = await this.countDevices(this.orgId);
    // One more than the cap, since the list also holds the stored organization.
    const list = pickListPage(
      await this.client.request({
        method: 'GET',
        path: '/organizations',
        label: '/organizations',
        query: { limit: HOLOGRAM_ORGANIZATION_SCAN_LIMIT + 1 },
        orgId: null,
      }),
    );
    const others = list.data
      .map(pickOrganization)
      .filter((o): o is HologramOrganization => o != null && String(o.id) !== this.orgId)
      .slice(0, HOLOGRAM_ORGANIZATION_SCAN_LIMIT);
    const otherOrganizations: SimOrganizationCount[] = [];
    for (const org of others) {
      const count = await this.countOtherDevices(String(org.id));
      if (count != null) {
        otherOrganizations.push({ id: String(org.id), name: org.name, deviceCount: count });
      }
    }
    return { deviceCount, otherOrganizations };
  }

  private async countDevices(orgId: string): Promise<number> {
    const count = pickData(
      await this.client.request({
        method: 'GET',
        path: '/devices/count',
        label: '/devices/count',
        orgId,
      }),
    );
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new SimProviderError('unavailable', 'Hologram answered the SIM count without a number');
    }
    return count;
  }

  /** Null for an organization the key can list but not count SIMs in. */
  private async countOtherDevices(orgId: string): Promise<number | null> {
    try {
      return await this.countDevices(orgId);
    } catch (err: unknown) {
      if (
        err instanceof SimProviderError &&
        (err.kind === 'unsupported' || err.kind === 'not_found')
      ) {
        return null;
      }
      throw err;
    }
  }

  private async getDevice(ref: SimRef): Promise<HologramDevice> {
    const deviceId = numericId(ref.providerSimId, 'device id');
    const device = pickDevice(
      pickData(
        await this.client.request({
          method: 'GET',
          path: `/devices/${String(deviceId)}`,
          label: '/devices/{deviceId}',
          // Hologram answers 400 for a device the key cannot reach.
          badRequest: 'not_found',
        }),
      ),
    );
    if (device == null) throw new SimProviderError('not_found', 'Hologram returned no device');
    return device;
  }

  private async getBillingUsage(simcardId: string): Promise<HologramBillingUsage | null> {
    try {
      return pickBillingUsage(
        pickData(
          await this.client.request({
            method: 'GET',
            path: `/usage/billing/simcard/${String(numericId(simcardId, 'SIM card id'))}`,
            label: '/usage/billing/simcard/{simcardId}',
            query: { with_session_details: true },
            badRequest: 'not_found',
          }),
        ),
      );
    } catch (err: unknown) {
      // A key without billing access (403) or a SIM card without a billing
      // period (404) still has a status, just without usage.
      if (
        err instanceof SimProviderError &&
        (err.kind === 'unsupported' || err.kind === 'not_found')
      ) {
        return null;
      }
      throw err;
    }
  }

  private async updateLocation(body: { linkids: number[] }, preview: boolean): Promise<void> {
    try {
      await this.client.request({
        method: 'POST',
        path: '/links/cellular/updatelocation',
        label: '/links/cellular/updatelocation',
        query: preview ? { preview: true } : {},
        body,
        badRequest: 'unsupported',
      });
    } catch (err: unknown) {
      if (err instanceof HologramRequestError && err.kind === 'unsupported') {
        const known =
          err.reply.error == null ? undefined : HOLOGRAM_RESET_REFUSALS[err.reply.error];
        const message =
          known == null
            ? 'Hologram refused the network reset'
            : `Hologram refused the network reset: ${known}`;
        throw new SimProviderError('unsupported', message, { cause: err });
      }
      throw err;
    }
  }
}

export const hologramFactory: SimProviderFactory = {
  id: 'hologram',
  create(settings, options) {
    const { enabled } = settings.hologram;
    const apiKey = settings.hologram.apiKey.trim();
    const orgId = settings.hologram.orgId.trim();
    // A malformed organization id counts as not configured; the settings route refuses to save one.
    if (!enabled || apiKey === '' || !isHologramOrgId(orgId)) return null;
    return new HologramProvider({
      apiKey,
      orgId,
      baseUrl:
        options.testBaseUrl == null ? HOLOGRAM_BASE_URL : `${options.testBaseUrl}/hologram/api/1`,
    });
  },
};
