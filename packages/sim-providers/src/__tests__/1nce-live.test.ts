// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Opt-in run of the 1NCE adapter against the real Management API. Skipped
// unless SIM_LIVE_1NCE_CLIENT_ID and SIM_LIVE_1NCE_CLIENT_SECRET are set;
// read-only; never resets a SIM unless SIM_LIVE_ALLOW_RESET=1. It prints
// states, counts, field names and HTTP codes only, never the client id, the
// secret, a token or an identifier.
//
// Required before 1NCE ships in a release (owner decision 2026-10-29): with a
// SIM in the account it confirms the SIM shape the adapter assumes from the
// spec (the event type ids, the history window, the session detail fields).
// Without a SIM the SIM checks are skipped with the reason.

import { describe, expect, it } from 'vitest';
import {
  ONENCE_EVENT_PAGE_SIZE,
  ONENCE_HISTORY_DAYS,
  ONENCE_PDP_EVENT_TYPES,
  OneNceProvider,
  pdpEventKind,
} from '../1nce/adapter.js';
import { ONENCE_BASE_URL } from '../1nce/client.js';
import { SimProviderError } from '../types.js';
import type { SimRef } from '../types.js';

const clientId = process.env['SIM_LIVE_1NCE_CLIENT_ID'] ?? '';
const clientSecret = process.env['SIM_LIVE_1NCE_CLIENT_SECRET'] ?? '';
const live = clientId !== '' && clientSecret !== '';
const allowReset = process.env['SIM_LIVE_ALLOW_RESET'] === '1';
const DAY_MS = 86_400_000;
// An ICCID no account holds (19 digits).
const UNKNOWN_ICCID = '8988303000000000099';

type Json = Record<string, unknown>;

/** The Luhn check digit of a digit string. */
function luhnDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    let digit = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
}

function report(message: string): void {
  // Counts, states and field names only.
  console.info(`[1nce-live] ${message}`);
}

async function token(): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${ONENCE_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, body };
}

async function raw(
  path: string,
  bearer: string,
  query: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Headers; bytes: number }> {
  const url = new URL(`${ONENCE_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch (err: unknown) {
    report(
      `non-JSON reply on ${path.replace(/\d{19,20}/, '{iccid}')}: ${String(err).slice(0, 40)}`,
    );
  }
  return { status: res.status, body, headers: res.headers, bytes: Buffer.byteLength(text) };
}

// Each test makes several live calls of up to 15 s each.
describe.skipIf(!live)('1NCE live API (opt-in, read-only)', { timeout: 120_000 }, () => {
  const provider = new OneNceProvider({ clientId, clientSecret });

  async function firstSim(): Promise<{ iccid: string; iccidWithLuhn: string } | null> {
    const t = await token();
    const list = await raw('/v2/sims', String(t.body['access_token']), {
      page: '1',
      pageSize: '1',
    });
    expect(list.status).toBe(200);
    const first = Array.isArray(list.body) ? (list.body[0] as Json | undefined) : undefined;
    if (first == null || typeof first['iccid'] !== 'string') return null;
    // Live (2026-10-30): the reply has no `iccid_with_luhn`; a station reports
    // the 19 digits plus their Luhn check digit.
    return {
      iccid: first['iccid'],
      iccidWithLuhn: `${first['iccid']}${luhnDigit(first['iccid'])}`,
    };
  }

  it('issues a bearer token with its lifetime', async () => {
    const t = await token();
    expect(t.status).toBe(200);
    expect(typeof t.body['access_token']).toBe('string');
    expect(String(t.body['token_type']).toLowerCase()).toBe('bearer');
    expect(typeof t.body['expires_in']).toBe('number');
    report(
      `token: expires_in ${String(t.body['expires_in'])}, length ${String(String(t.body['access_token']).length)}`,
    );
  });

  it('maps wrong credentials to auth', async () => {
    const wrong = new OneNceProvider({ clientId, clientSecret: 'sim-live-test-wrong-secret' });
    const err: unknown = await wrong.testConnection().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimProviderError);
    expect((err as SimProviderError).kind).toBe('auth');
    expect(String(err)).not.toContain(clientId);
  });

  it('answers a missing and an invalid bearer with 401', async () => {
    const missing = await fetch(`${ONENCE_BASE_URL}/v2/sims?page=1&pageSize=1`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    await missing.body?.cancel();
    expect(missing.status).toBe(401);
    const invalid = await raw('/v2/sims', 'sim-live-test-invalid-token', { pageSize: '1' });
    expect(invalid.status).toBe(401);
  });

  it('counts the SIMs of the account through Test Connection', async () => {
    const result = await provider.testConnection();
    expect(Number.isSafeInteger(result.deviceCount)).toBe(true);
    expect(result.otherOrganizations).toEqual([]);
    report(`Test Connection: ${String(result.deviceCount)} SIMs`);
  });

  it('answers the 400 of a page size over 100 and the rate limit headers', async () => {
    const t = await token();
    const bearer = String(t.body['access_token']);
    const over = await raw('/v2/sims', bearer, { page: '1', pageSize: '101' });
    expect(over.status).toBe(400);
    const ok = await raw('/v2/sims', bearer, { page: '1', pageSize: '1' });
    report(
      `rate limit headers: ratelimit-limit ${ok.headers.get('ratelimit-limit') ?? 'absent'}, ratelimit-reset ${ok.headers.get('ratelimit-reset') ?? 'absent'}`,
    );
  });

  it('finds no SIM for an unknown ICCID', async () => {
    expect(await provider.findByIccid(UNKNOWN_ICCID)).toBeNull();
  });

  it('reads a SIM of the account: lookup, status, sessions and alerts', async (ctx) => {
    const sim = await firstSim();
    if (sim == null) {
      report('skipped the SIM checks: the account holds no SIM yet');
      ctx.skip();
      return;
    }
    const ref = (await provider.findByIccid(sim.iccid)) as SimRef;
    expect(ref).not.toBeNull();
    // The 20-digit form answers 404 at 1NCE; the adapter asks with the 19 digits.
    expect(await provider.findByIccid(sim.iccidWithLuhn)).toEqual(ref);
    const status = await provider.getStatus(ref);
    expect(status.state).not.toBe('unknown');
    expect(status.providerState).toMatch(
      /^(Enabled|Disabled)( \((ONLINE|ATTACHED|OFFLINE|BLOCKED)\))?$/,
    );
    report(
      `status: state ${status.state}, provider state ${status.providerState}, in session ${String(status.inSession)}, usage ${status.usage == null ? 'none' : 'present'}`,
    );
    const range = { from: new Date(Date.now() - ONENCE_HISTORY_DAYS * DAY_MS), to: new Date() };
    const sessions = await provider.listSessions(ref, { range });
    const alerts = await provider.listAlerts(ref, { range });
    report(
      `sessions ${String(sessions.items.length)} (covered from ${sessions.coveredFrom ?? 'range start'}), alerts ${alerts.items.map((a) => a.kind).join(',') || 'none'}`,
    );
  });

  it('reports the event shape a real SIM shows (types, window, detail fields, page size)', async (ctx) => {
    const sim = await firstSim();
    if (sim == null) {
      report('skipped the event shape report: the account holds no SIM yet');
      ctx.skip();
      return;
    }
    const t = await token();
    const page = await raw(`/v2/sims/${sim.iccid}/events`, String(t.body['access_token']), {
      page: '1',
      pageSize: String(ONENCE_EVENT_PAGE_SIZE),
    });
    expect(page.status).toBe(200);
    const events = Array.isArray(page.body) ? (page.body as Json[]) : [];
    expect(page.headers.get('x-current-page')).toBe('1');
    expect(page.headers.get('x-total-count')).toMatch(/^\d+$/);
    const types = new Map<string, number>();
    let oldest: number | null = null;
    const detailFields = new Set<string>();
    let ordered = true;
    let idsDescending = true;
    let previous: number | null = null;
    let previousId: number | null = null;
    let pdpEvents = 0;
    for (const event of events) {
      const type = event['event_type'] as Json | undefined;
      const key = `${String(type?.['id'])} ${String(type?.['description'])}`;
      types.set(key, (types.get(key) ?? 0) + 1);
      const kind = pdpEventKind({
        typeId: typeof type?.['id'] === 'number' ? type['id'] : null,
        typeName: typeof type?.['description'] === 'string' ? type['description'] : null,
      });
      if (kind != null) pdpEvents += 1;
      const at = Date.parse(String(event['timestamp']));
      if (!Number.isNaN(at) && (oldest == null || at < oldest)) oldest = at;
      if (previous != null && !Number.isNaN(at) && at > previous) ordered = false;
      if (!Number.isNaN(at)) previous = at;
      const id = typeof event['id'] === 'number' ? event['id'] : null;
      if (previousId != null && id != null && id > previousId) idsDescending = false;
      if (id != null) previousId = id;
      const detail = event['detail'] as Json | undefined;
      const context = detail?.['pdp_context'] as Json | undefined;
      if (detail?.['name'] != null) detailFields.add('detail.name');
      if (context?.['rat_type'] != null) detailFields.add('pdp_context.rat_type');
      if (context?.['ci'] != null) detailFields.add('pdp_context.ci');
      if ((context?.['gtp_v2_uli'] as Json | undefined)?.['eci'] != null) {
        detailFields.add('pdp_context.gtp_v2_uli.eci');
      }
      if ((context?.['gtp_v1_uli'] as Json | undefined)?.['ci'] != null) {
        detailFields.add('pdp_context.gtp_v1_uli.ci');
      }
    }
    report(
      `event types seen: ${[...types.entries()].map(([k, n]) => `${k} x${String(n)}`).join('; ') || 'none'}`,
    );
    report(
      `assumed PDP types: create ${String(ONENCE_PDP_EVENT_TYPES.create)}, delete ${String(ONENCE_PDP_EVENT_TYPES.delete)}`,
    );
    report(
      `oldest event ${oldest == null ? 'none' : `${(Math.round(((Date.now() - oldest) / DAY_MS) * 10) / 10).toFixed(1)} days old`}, newest first ${String(ordered)}, ids descending ${String(idsDescending)}`,
    );
    report(`PDP context events: ${String(pdpEvents)}`);
    report(`session detail fields present: ${[...detailFields].join(', ') || 'none'}`);
    report(`first events page: ${String(events.length)} events, ${String(page.bytes)} bytes`);
    // The adapter's paging relies on newest first by time (live, 2026-10-30).
    expect(ordered).toBe(true);
  });

  it('answers a page past the last one with the last page, and refuses an events page over 1000', async (ctx) => {
    const sim = await firstSim();
    if (sim == null) {
      report('skipped the events paging check: the account holds no SIM yet');
      ctx.skip();
      return;
    }
    const t = await token();
    const bearer = String(t.body['access_token']);
    const first = await raw(`/v2/sims/${sim.iccid}/events`, bearer, { page: '1', pageSize: '1' });
    const pages = Number(first.headers.get('x-total-pages'));
    expect(Number.isSafeInteger(pages)).toBe(true);
    const past = await raw(`/v2/sims/${sim.iccid}/events`, bearer, {
      page: String(pages + 1),
      pageSize: '1',
    });
    expect(past.status).toBe(200);
    // The adapter stops on `X-Current-Page` other than the page it asked for.
    expect(past.headers.get('x-current-page')).toBe(String(Math.max(1, pages)));
    const over = await raw(`/v2/sims/${sim.iccid}/events`, bearer, {
      page: '1',
      pageSize: String(ONENCE_EVENT_PAGE_SIZE + 1),
    });
    expect(over.status).toBe(400);
    report(`events paging: ${String(pages)} pages of 1, a page past the last answers the last`);
  });

  it.skipIf(!allowReset)('resets the network of a SIM (SIM_LIVE_ALLOW_RESET=1)', async (ctx) => {
    const sim = await firstSim();
    if (sim == null) {
      report('skipped the reset: the account holds no SIM yet');
      ctx.skip();
      return;
    }
    expect(await provider.resetNetwork({ providerSimId: sim.iccid })).toEqual({
      status: 'submitted',
    });
  });
});
