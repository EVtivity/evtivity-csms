// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { buildSystemBlocks } from '../services/ai/engine/prompt.js';
import type { SystemPromptInput } from '../services/ai/engine/prompt.js';
import { explainPromptBlock } from '../services/ai/engine/explain-context.js';
import type { ExplainSubject, ExplainTurnContext } from '../services/ai/engine/explain-context.js';

const NOW = new Date('2026-10-10T12:00:00Z');

const BASE: SystemPromptInput = {
  surface: 'chatbot',
  language: 'en',
  operatorPrompt: '',
  userName: 'Ada Lovelace',
  companyCurrency: 'EUR',
  now: NOW,
};

const SUBJECT: ExplainSubject = {
  kind: 'station',
  id: 'sta_1',
  siteId: 'site_1',
  label: 'CS-0001',
  stationId: 'sta_1',
  ocppStationId: 'CS-0001',
  sessionId: null,
  authorizeAttemptId: null,
  reservationId: null,
  insightId: null,
};

const OK: ExplainTurnContext = {
  kind: 'station',
  id: 'sta_1',
  resolution: { status: 'ok', subject: SUBJECT },
};

describe('Explain prompt block', () => {
  it('TC-AI-EX-02 the record reference goes into the dynamic block only; the static block is unchanged', () => {
    const block = explainPromptBlock(OK);
    const [plainStatic, plainDynamic] = buildSystemBlocks(BASE);
    const [s, d] = buildSystemBlocks({ ...BASE, explainContext: block });
    expect(s).toEqual(plainStatic);
    expect(s?.cacheable).toBe(true);
    expect(d?.cacheable).toBe(false);
    expect(d?.text.startsWith(plainDynamic?.text ?? '')).toBe(true);
    expect(d?.text).toContain('<untrusted source="explain_context" id="station:sta_1">');
  });

  it('TC-AI-EX-02 carries only the kind, label and ids: the assistant reads the record with its tools', () => {
    const block = explainPromptBlock(OK);
    const json = /<untrusted[^>]*>\n?([\s\S]*?)\n?<\/untrusted>/.exec(block)?.[1] ?? '';
    expect(JSON.parse(json)).toEqual({
      kind: 'station',
      id: 'sta_1',
      label: 'CS-0001',
      stationId: 'sta_1',
      ocppStationId: 'CS-0001',
    });
    expect(block).toContain('read tools');
    expect(block).not.toMatch(/insight"|recentEvents|headline/);
  });

  it('TC-AI-RI-13 frames a reservation record by its ids', () => {
    const subject: ExplainSubject = {
      kind: 'reservation',
      id: 'res_1',
      siteId: 'site_1',
      label: '#12',
      stationId: 'sta_1',
      ocppStationId: 'CS-0001',
      sessionId: null,
      authorizeAttemptId: null,
      reservationId: 'res_1',
      insightId: null,
    };
    const block = explainPromptBlock({
      kind: 'reservation',
      id: 'res_1',
      resolution: { status: 'ok', subject },
    });
    expect(block).toContain('<untrusted source="explain_context" id="reservation:res_1">');
    expect(block).toContain('"reservationId":"res_1"');
    expect(block).toContain('"label":"#12"');
  });

  it('frames an insight by its id and the ids of its records', () => {
    const subject: ExplainSubject = {
      kind: 'insight',
      id: 'ain_1',
      siteId: 'site_1',
      label: 'ain_1',
      stationId: 'sta_1',
      ocppStationId: 'CS-0001',
      sessionId: 'ses_1',
      authorizeAttemptId: null,
      reservationId: null,
      insightId: 'ain_1',
    };
    const block = explainPromptBlock({
      kind: 'insight',
      id: 'ain_1',
      resolution: { status: 'ok', subject },
    });
    const json = /<untrusted[^>]*>\n?([\s\S]*?)\n?<\/untrusted>/.exec(block)?.[1] ?? '';
    expect(JSON.parse(json)).toEqual({
      kind: 'insight',
      id: 'ain_1',
      label: 'ain_1',
      stationId: 'sta_1',
      ocppStationId: 'CS-0001',
      sessionId: 'ses_1',
      insightId: 'ain_1',
    });
  });

  it('TC-AI-EX-02 the support surface never receives an Explain block', () => {
    const [, d] = buildSystemBlocks({
      ...BASE,
      surface: 'support',
      explainContext: 'Explain context: should not appear',
    });
    expect(d?.text).not.toContain('Explain context');
  });

  it('TC-AI-EX-02 a deleted record is reported as no longer available, without data', () => {
    const block = explainPromptBlock({
      kind: 'session',
      id: 'ses_1',
      resolution: { status: 'missing' },
    });
    expect(block).toContain('session record this conversation was opened from is no longer');
    expect(block).not.toContain('<untrusted');
  });
});
