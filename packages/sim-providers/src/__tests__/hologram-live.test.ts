// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Opt-in run of the Hologram adapter against the real API. Skipped unless
// SIM_LIVE_HOLOGRAM_API_KEY and SIM_LIVE_HOLOGRAM_ORG_ID are set; never resets a SIM
// unless SIM_LIVE_ALLOW_RESET=1. It prints states, counts and field names only, never
// the key or an identifier.

import { describe, expect, it } from 'vitest';
import {
  HOLOGRAM_ALERT_TOPICS,
  HOLOGRAM_HISTORY_DAYS,
  HologramProvider,
} from '../hologram/adapter.js';
import { HOLOGRAM_BASE_URL } from '../hologram/client.js';
import { SimProviderError } from '../types.js';
import type { SimRef } from '../types.js';

const apiKey = process.env['SIM_LIVE_HOLOGRAM_API_KEY'] ?? '';
const orgId = process.env['SIM_LIVE_HOLOGRAM_ORG_ID'] ?? '';
const live = apiKey !== '' && orgId !== '';
const DAY_MS = 86_400_000;
// Link fields the adapter does not rely on until this test sees them in a reply.
const UNDOCUMENTED_LINK_FIELDS = [
  'last_network_used',
  'last_connect_time',
  'cur_billing_data_used',
  'data_threshold',
] as const;

type Json = Record<string, unknown>;

async function raw(
  path: string,
  query: Record<string, string> = {},
  key = apiKey,
): Promise<{ status: number; body: Json }> {
  const url = new URL(`${HOLOGRAM_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { authorization: `Basic ${Buffer.from(`apikey:${key}`).toString('base64')}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, body };
}

function firstLink(device: Json): Json | null {
  const links = (device['links'] as Json | undefined)?.['cellular'];
  return Array.isArray(links) && links.length > 0 ? (links[0] as Json) : null;
}

function expectListShape(body: Json): void {
  expect(body['success']).toBe(true);
  expect(Array.isArray(body['data'])).toBe(true);
  expect(typeof body['continues']).toBe('boolean');
  expect(typeof body['limit']).toBe('number');
  expect(typeof body['size']).toBe('number');
}

describe.skipIf(!live)('Hologram live API (opt-in)', () => {
  const provider = new HologramProvider({ apiKey, orgId });

  async function liveSim(): Promise<{ iccid: string; ref: SimRef; link: Json; device: Json }> {
    const list = await raw('/devices', { orgid: orgId, limit: '10' });
    expect(list.status).toBe(200);
    const device = (list.body['data'] as Json[]).find((d) => firstLink(d)?.['sim'] != null);
    expect(device, 'the account has a device with a SIM').toBeDefined();
    const link = firstLink(device as Json) as Json;
    const iccid = String(link['sim']);
    const ref = await provider.findByIccid(iccid);
    expect(ref).not.toBeNull();
    return { iccid, ref: ref as SimRef, link, device: device as Json };
  }

  it('answers a wrong key with 403 Invalid API Key, mapped to auth', async () => {
    const res = await raw(`/organizations/${orgId}`, {}, 'sim-live-test-wrong-key');
    expect(res.status).toBe(403);
    expect(res.body['error']).toBe('Invalid API Key');
    const wrong = new HologramProvider({ apiKey: 'sim-live-test-wrong-key', orgId });
    await expect(wrong.testConnection()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('reads the user and the organization with the key (Test Connection)', async () => {
    expect((await raw('/users/me')).status).toBe(200);
    expect((await raw(`/organizations/${orgId}`)).status).toBe(200);
    const orgs = await raw('/organizations', { limit: '11' });
    expect(orgs.status).toBe(200);
    expectListShape(orgs.body);
    const result = await provider.testConnection();
    expect(result.deviceCount).toBeGreaterThanOrEqual(1);
    console.info(
      `test connection: ${String(result.deviceCount)} SIMs, ${String(result.otherOrganizations.length)} other organizations`,
    );
  });

  it('looks the SIM up by ICCID and reads its status and usage', async () => {
    const { iccid, ref, link, device } = await liveSim();
    const byIccid = await raw('/devices', { orgid: orgId, iccid });
    expect(byIccid.status).toBe(200);
    expect((byIccid.body['data'] as Json[]).length).toBeGreaterThanOrEqual(1);
    const one = await raw(`/devices/${ref.providerSimId}`, { orgid: orgId });
    expect(one.status).toBe(200);
    const usage = await raw(`/usage/billing/simcard/${String(ref.simcardId)}`, {
      orgid: orgId,
      with_session_details: 'true',
    });
    expect(usage.status).toBe(200);
    const status = await provider.getStatus(ref);
    expect(status.providerState).not.toBe('');
    expect(status.state).not.toBe('unknown');
    const present = UNDOCUMENTED_LINK_FIELDS.filter((f) => f in link || f in device);
    console.info(
      `status: ${status.state} (${status.providerState}), in session ${String(status.inSession)}; undocumented link fields present: ${present.length > 0 ? present.join(', ') : 'none'}`,
    );
  });

  it('pages the sessions and the SIM alerts of the history window', async () => {
    const { ref } = await liveSim();
    const range = { from: new Date(Date.now() - HOLOGRAM_HISTORY_DAYS * DAY_MS), to: new Date() };
    const sessionsRaw = await raw('/usage/data/', {
      orgid: orgId,
      linkid: String(ref.linkId),
      limit: '5',
    });
    expect(sessionsRaw.status).toBe(200);
    expectListShape(sessionsRaw.body);
    const alertsRaw = await raw('/csr/data', {
      orgid: orgId,
      deviceid: ref.providerSimId,
      topicnames: Object.keys(HOLOGRAM_ALERT_TOPICS).join(','),
      limit: '5',
    });
    expect(alertsRaw.status).toBe(200);
    expectListShape(alertsRaw.body);
    const sessions = await provider.listSessions(ref, { range });
    const alerts = await provider.listAlerts(ref, { range });
    const oldest = sessions.items.at(-1)?.startedAt;
    const oldestDays =
      oldest == null ? null : Math.floor((Date.now() - Date.parse(oldest)) / DAY_MS);
    console.info(
      `history: ${String(sessions.items.length)} sessions (oldest ${oldestDays == null ? 'none' : `${String(oldestDays)} days ago`}, continues ${String(sessions.continues)}), ${String(alerts.items.length)} alerts`,
    );
  });

  it.skipIf(process.env['SIM_LIVE_ALLOW_RESET'] !== '1')(
    'resets the network of the SIM',
    async () => {
      const { ref } = await liveSim();
      try {
        expect(await provider.resetNetwork(ref)).toEqual({ status: 'accepted' });
      } catch (err) {
        if (err instanceof SimProviderError) {
          throw new Error(`reset refused: ${err.kind}`, { cause: err });
        }
        throw err;
      }
    },
  );
});
