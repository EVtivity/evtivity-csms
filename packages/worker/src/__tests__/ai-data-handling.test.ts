// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI data handling, worker surfaces (rule `features/ai-data-handling.md`):
 * insight generation, insight translation and the background workers, each
 * through its real model call function against a provider that records the
 * HTTP request body. The database and the insight service are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger, PubSubClient } from '@evtivity/lib';
import { buildAiSettings } from '@evtivity/lib/ai-config';
import { AI_WORKER_JOBS } from '@evtivity/lib/ai-proposals';
import type { InsightKind } from '@evtivity/lib/ai-insights';
import {
  findLeaks,
  seededRecord,
  seededText,
  startRecordingProvider,
} from '@evtivity/ai/testing/harness';
import type { RecordingProvider } from '@evtivity/ai/testing/harness';
import { createHash } from 'node:crypto';
import {
  buildReservationEvidence,
  INSIGHT_SUBJECT_TYPES,
  renderEvidencePack,
  evidenceIds,
} from '@evtivity/services/ai-evidence';
import type { EvidencePack, InsightSubjectType } from '@evtivity/services/ai-evidence';
import type { OpsAiConfig } from '@evtivity/services/ai-ops-config';

const svc = vi.hoisted(() => ({
  getInsightRow: vi.fn(),
  insightTexts: vi.fn(),
  storeInsightTranslation: vi.fn(),
  publishInsightUpdated: vi.fn(),
}));
const settingsState = vi.hoisted((): { settings: unknown } => ({ settings: null }));
const opsConfig = vi.hoisted((): { config: unknown } => ({ config: null }));

vi.mock('@evtivity/services/ai-insight.service', () => ({
  ...svc,
  AI_INSIGHT_REQUESTS_CHANNEL: 'ai_insight_requests',
}));
vi.mock('@evtivity/services/ai-ops-config', () => ({
  resolveOpsAiConfig: () => opsConfig.config,
}));
vi.mock('../lib/config.js', () => ({ config: { SETTINGS_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@evtivity/database', () => ({
  recordAiUsage: vi.fn(),
  checkAiBudgets: vi.fn(() => Promise.resolve({ allowed: true })),
  getAiSettings: () => Promise.resolve(settingsState.settings),
  toIsoOrNull: (v: Date | string | null | undefined) =>
    v == null ? null : new Date(v).toISOString(),
  client: () => Promise.resolve([{ enabled: true }]),
}));

const { askInsightModel } = await import('../ai-insights/generate.js');
const { translateInsight } = await import('../ai-insights/translate.js');
const { runOpsNarrative } = await import('../ai-workers/ops-model.js');
const { stuckSessionFacts } = await import('../ai-workers/prompts.js');

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

let provider: RecordingProvider | null = null;

function config(p: RecordingProvider): OpsAiConfig {
  return {
    provider: 'anthropic',
    apiKey: 'sk-data-handling-test',
    baseUrl: '',
    model: p.model,
    effort: 'low',
    systemPrompt: '',
  };
}

beforeEach(() => {
  settingsState.settings = buildAiSettings([
    { key: 'opsAi.enabled', value: true },
    { key: 'opsAi.provider', value: 'anthropic' },
  ]);
});

afterEach(async () => {
  await provider?.close();
  provider = null;
  vi.clearAllMocks();
});

/** A pack of `type` holding every seeded value in facts, items and station text. */
function seededPack(type: InsightSubjectType): EvidencePack {
  return {
    subject: { type, id: `${type}_1`, siteId: 'sit_1' },
    facts: { ...seededRecord(), status: 'Faulted' },
    items: [{ id: 'ev_1', kind: 'status', data: seededRecord() }],
    untrusted: [{ id: 'ev_1', source: 'station_status_info', text: seededText() }],
  };
}

const KIND_BY_SUBJECT: Record<InsightSubjectType, InsightKind> = {
  station: 'station_faulted',
  session: 'session_failed',
  authorization: 'authorization_refused',
  reservation: 'reservation_station_faulted',
  site: 'site_incident',
  company: 'company_summary',
};

describe('AI data handling: worker surfaces', () => {
  it.each(INSIGHT_SUBJECT_TYPES)(
    'TC-AI-AD-04 insight evidence (%s pack) carries no secret, personal data masked',
    async (type) => {
      provider = await startRecordingProvider();
      const rendered = renderEvidencePack(seededPack(type));
      await askInsightModel({
        adapter: provider.adapter,
        config: config(provider),
        kind: KIND_BY_SUBJECT[type],
        language: 'en',
        evidenceText: rendered.text,
        evidenceIds: evidenceIds(rendered.pack),
        allowed: () => Promise.resolve(true),
        ledger: { surface: 'insight', siteId: 'sit_1', insightId: 'ins_1', userId: null },
        log,
      });
      const bodies = provider.bodies();
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body).toContain('Evidence (JSON)');
        expect(findLeaks(body, 'support')).toEqual([]);
        expect(body).toContain('j***@example.com');
        expect(body).toMatch(/sha256:[0-9a-f]{12}/);
      }
    },
  );

  it('TC-AI-AD-04 a reservation pack sends the driver as a keyed hash: never the id or its plain sha256', async () => {
    const driverId = 'drv_reservation_holder_1';
    const pack = buildReservationEvidence(
      {
        reservation: {
          id: 'res_1',
          reservation_id: 7,
          station_id: 'sta_1',
          site_id: 'sit_1',
          evse_ocpp_id: 1,
          driver_id: driverId,
          has_token: true,
          status: 'expired',
          starts_at: null,
          expires_at: '2026-10-10 11:00:00+00',
          created_at: '2026-10-10 10:00:00+00',
          updated_at: '2026-10-10 11:00:00+00',
          cancelled_by: null,
          cancel_reason: null,
          station_ack_at: '2026-10-10 10:00:01+00',
          no_show_fee_state: 'charged',
          cancellation_fee_cents: 0,
        },
        audit: [],
        messages: [],
        payments: [],
        station: null,
      },
      new Date('2026-10-10T11:05:00Z'),
      'test-subject-secret',
    );
    provider = await startRecordingProvider();
    const rendered = renderEvidencePack(pack);
    await askInsightModel({
      adapter: provider.adapter,
      config: config(provider),
      kind: 'reservation_no_show',
      language: 'en',
      evidenceText: rendered.text,
      evidenceIds: evidenceIds(rendered.pack),
      allowed: () => Promise.resolve(true),
      ledger: { surface: 'insight', siteId: 'sit_1', insightId: 'ins_1', userId: null },
      log,
    });
    const bodies = provider.bodies();
    expect(bodies.length).toBeGreaterThan(0);
    const plain = createHash('sha256').update(driverId).digest('hex');
    for (const body of bodies) {
      expect(body).toContain('driver:');
      expect(body).not.toContain(driverId);
      expect(body).not.toContain(plain.slice(0, 16));
    }
  });

  it('TC-AI-AD-06 insight translations send the stored summary only, no evidence', async () => {
    provider = await startRecordingProvider([{ text: 'Station hors ligne.' }]);
    const p = provider;
    const summary = `Station CS-1 went offline. ${seededText()}`;
    svc.getInsightRow.mockResolvedValue({ id: 'ins_1', kind: 'station_offline', siteId: 'sit_1' });
    svc.insightTexts.mockResolvedValue(
      new Map([
        ['ins_1', { requested: { status: 'pending' }, primary: { status: 'ready', summary } }],
      ]),
    );
    svc.storeInsightTranslation.mockResolvedValue(true);
    const outcome = await translateInsight(
      'ins_1',
      'fr',
      {
        getSettings: () => Promise.resolve(settingsState.settings as never),
        resolveConfig: () => config(p),
        createAdapter: () => p.adapter,
        checkBudgets: () => Promise.resolve({ allowed: true }),
        pubsub: { publish: vi.fn() } as unknown as PubSubClient,
        now: () => new Date(),
        subjectSecret: 'test-subject-secret',
      },
      log,
    );
    expect(outcome).toBe('translated');
    const [body] = provider.bodies();
    expect(body).toContain('insight_summary');
    expect(body).toContain('Station CS-1 went offline.');
    expect(body).not.toContain('Evidence (JSON)');
    expect(findLeaks(body ?? '', 'support')).toEqual([]);
  });

  it.each(AI_WORKER_JOBS)(
    'TC-AI-AD-07 background worker %s: the provider request carries no secret, personal data masked',
    async (job) => {
      provider = await startRecordingProvider();
      const p = provider;
      opsConfig.config = config(p);
      const facts = {
        ...stuckSessionFacts(
          {
            ocppStationId: 'CS-1',
            transactionId: 'tx-1',
            reason: 'no_activity',
            startedAt: new Date('2026-10-11T06:00:00Z'),
            lastActivityAt: new Date('2026-10-11T07:00:00Z'),
          },
          { idleMinutes: 90, now: new Date('2026-10-11T09:00:00Z') },
        ),
        // Whatever a future job adds to its facts is redacted too.
        extra: seededRecord(),
        note: seededText(),
      };
      const result = await runOpsNarrative(
        { job, siteId: 'sit_1', workerRunId: 1, facts },
        {
          createAdapter: () => p.adapter,
          checkBudgets: () => Promise.resolve({ allowed: true }),
          encryptionKey: 'test-key',
          allowPrivateHosts: true,
        },
      );
      expect(result.kind).toBe('ok');
      const [body] = provider.bodies();
      expect(body).toContain('worker_facts');
      expect(body).toContain('CS-1');
      expect(findLeaks(body ?? '', 'support')).toEqual([]);
    },
  );
});
