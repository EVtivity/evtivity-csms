// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * TC-AI-AD-10 and TC-AI-AD-11: no model call skips the provider boundary
 * redaction, every usage surface has a redaction level and a request-body
 * test, and the data handling rule (`features/ai-data-handling.md`) covers
 * every surface with a note that claims nothing its table does not hold.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_USAGE_SURFACES } from '@evtivity/lib/ai-usage';
import type { AiUsageSurface } from '@evtivity/lib/ai-usage';
import { AI_USAGE_REDACTION_SURFACES } from '../redact.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
/** Every package that can hold a model call; the adapters themselves are skipped. */
const SCANNED = [
  'packages/ai/src',
  'packages/api/src',
  'packages/worker/src',
  'packages/services/src',
  'packages/ocpi/src',
];
const SKIPPED_DIRS = new Set(['__tests__', '__integration__', '__contract__', 'generated']);
const SKIPPED_PATHS = ['packages/ai/src/providers/'];
const SPEC = join(ROOT, 'packages/ai/src/__contract__/data-handling.md');

/**
 * The request-body test of every usage surface: the file and the case id it
 * holds. Typed over the usage surfaces, so a new surface needs an entry.
 */
const REQUEST_BODY_TESTS: Readonly<Record<AiUsageSurface, { file: string; id: string }>> = {
  chatbot: { file: 'packages/api/src/__tests__/ai-data-handling.test.ts', id: 'TC-AI-AD-01' },
  support: { file: 'packages/api/src/__tests__/ai-data-handling.test.ts', id: 'TC-AI-AD-03' },
  insight: { file: 'packages/worker/src/__tests__/ai-data-handling.test.ts', id: 'TC-AI-AD-04' },
  insight_translation: {
    file: 'packages/worker/src/__tests__/ai-data-handling.test.ts',
    id: 'TC-AI-AD-06',
  },
  worker: { file: 'packages/worker/src/__tests__/ai-data-handling.test.ts', id: 'TC-AI-AD-07' },
  driver_support: {
    file: 'packages/ai/src/__tests__/ai-data-handling.test.ts',
    id: 'TC-AI-AD-09',
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (SKIPPED_PATHS.some((p) => relative(ROOT, path).startsWith(p))) continue;
    if (statSync(path).isDirectory()) {
      if (SKIPPED_DIRS.has(name)) continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** A model call on a provider adapter (`AiAdapter.stream` / `AiAdapter.complete`). */
const MODEL_CALL = /\badapter\.(stream|complete)\(/g;
/** The request argument of the call is the boundary redaction itself. */
const REDACTED_CALL = /^\s*redactProviderRequest\(/;

describe('AI data handling guard', () => {
  it('TC-AI-AD-10 every usage surface maps to a redaction level and has a request-body test', () => {
    expect(Object.keys(AI_USAGE_REDACTION_SURFACES).sort()).toEqual([...AI_USAGE_SURFACES].sort());
    for (const surface of AI_USAGE_SURFACES) {
      const test = REQUEST_BODY_TESTS[surface];
      const path = join(ROOT, test.file);
      expect(existsSync(path), `${surface}: ${test.file}`).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text.includes(`'${test.id} `), `${surface}: ${test.id} in ${test.file}`).toBe(true);
      expect(/findLeaks\(/.test(text), `${test.file} asserts on the request body`).toBe(true);
    }
  });

  it('TC-AI-AD-10 every model call passes its request through redactProviderRequest', () => {
    const files = SCANNED.flatMap((d) => sourceFiles(join(ROOT, d)));
    let calls = 0;
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(MODEL_CALL)) {
        calls++;
        const after = text.slice(match.index + match[0].length);
        expect(
          REDACTED_CALL.test(after),
          `${relative(ROOT, path)} calls adapter.${match[1] ?? ''}() without redactProviderRequest`,
        ).toBe(true);
      }
    }
    // turn-runner, router, insight generation, translation, workers.
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  it('TC-AI-AD-10 a literal redaction surface is a usage surface, the one the file records', () => {
    const files = SCANNED.flatMap((d) => sourceFiles(join(ROOT, d)));
    let literals = 0;
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      const recorded = new Set(
        [...text.matchAll(/recordAiUsage\(\{[\s\S]*?surface: '([a-z_]+)'/g)].map((m) => m[1]),
      );
      for (const m of text.matchAll(/redactProviderRequest\([\s\S]*?,\s*'([a-z_]+)',?\s*\)/g)) {
        literals++;
        const surface = m[1] ?? '';
        const file = relative(ROOT, path);
        expect(AI_USAGE_SURFACES as readonly string[], `${file}: ${surface}`).toContain(surface);
        if (recorded.size > 0) {
          expect(recorded.has(surface), `${file} redacts as ${surface} but records otherwise`).toBe(
            true,
          );
        }
      }
    }
    // router (chatbot), insight generation, translation, workers.
    expect(literals).toBeGreaterThanOrEqual(4);
  });
});

interface Row {
  surface: string;
  usage: string;
  never: string;
  masked: string;
  asIs: string;
}

function tableRows(text: string): Row[] {
  const section = text.split('## Surface table')[1]?.split('\n## ')[0] ?? '';
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim().replace(/`/g, ''));
      return {
        surface: cells[0] ?? '',
        usage: cells[1] ?? '',
        never: cells[3] ?? '',
        masked: cells[4] ?? '',
        asIs: cells[5] ?? '',
      };
    });
}

const COLUMN = { never: 'never', masked: 'masked', 'as is': 'asIs' } as const;

/** Note words and the claim categories that cover them. */
const NOTE_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  credential: ['stored credentials'],
  password: ['stored credentials', 'station passwords'],
  key: ['stored credentials', 'secret-shaped values'],
  secret: ['stored credentials', 'secret-shaped values'],
  card: ['card numbers'],
  iban: ['IBANs'],
  email: ['email addresses'],
  phone: ['phone numbers'],
  token: ['token ids'],
  contact: ['driver contact details'],
  image: ['images and PDFs'],
  pdf: ['images and PDFs'],
};

describe('AI data handling table, claims and notes (__contract__/data-handling.md)', () => {
  const text = readFileSync(SPEC, 'utf8');
  const rows = tableRows(text);
  const claims = [...text.matchAll(/^- (never|masked|as is): ([^|]+)\| (.+)$/gm)].map((m) => ({
    column: COLUMN[m[1] as keyof typeof COLUMN],
    category: (m[2] ?? '').trim(),
    surfaces: (m[3] ?? '').split(',').map((s) => s.trim()),
  }));
  const note = /```note\n([\s\S]+?)\n```/.exec(text)?.[1] ?? '';
  const driverNote = /```note-driver\n([\s\S]+?)\n```/.exec(text)?.[1] ?? '';

  it('TC-AI-AD-11 the table names every usage surface and MCP', () => {
    const usages = new Set(rows.map((r) => r.usage));
    for (const surface of AI_USAGE_SURFACES) expect(usages.has(surface), surface).toBe(true);
    expect(rows.some((r) => r.surface === 'mcp')).toBe(true);
    for (const row of rows) {
      if (row.usage === 'none') continue;
      expect(AI_USAGE_SURFACES as readonly string[], row.surface).toContain(row.usage);
    }
  });

  it('TC-AI-AD-11 every claim holds in its column for every row it names', () => {
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      for (const surface of claim.surfaces) {
        const row = rows.find((r) => r.surface === surface);
        expect(row, `claim "${claim.category}" names unknown row ${surface}`).toBeDefined();
        expect(
          row?.[claim.column].includes(claim.category),
          `${surface}: "${claim.category}" is not in its ${claim.column} column`,
        ).toBe(true);
      }
    }
  });

  it('TC-AI-AD-11 the note uses no category word without a claim', () => {
    expect(note.length).toBeGreaterThan(0);
    const categories = new Set(claims.map((c) => c.category));
    const lower = note.toLowerCase();
    for (const [word, covers] of Object.entries(NOTE_VOCABULARY)) {
      if (!lower.includes(word)) continue;
      expect(
        covers.some((c) => categories.has(c)),
        `the note says "${word}" without a claim`,
      ).toBe(true);
    }
    // Never sent claims hold for every surface that reaches a provider.
    for (const claim of claims.filter((c) => c.category === 'stored credentials')) {
      const providerRows = rows.filter((r) => r.surface !== 'chatbot-attachments');
      for (const row of providerRows) expect(claim.surfaces, row.surface).toContain(row.surface);
    }
  });

  it('TC-AI-AD-11 the driver note claims only what the driver_support row holds', () => {
    expect(driverNote.length).toBeGreaterThan(0);
    const driverCategories = new Set(
      claims.filter((c) => c.surfaces.includes('driver_support')).map((c) => c.category),
    );
    const lower = driverNote.toLowerCase();
    for (const [word, covers] of Object.entries(NOTE_VOCABULARY)) {
      if (!lower.includes(word)) continue;
      expect(
        covers.some((c) => driverCategories.has(c)),
        `the driver note says "${word}" without a driver_support claim`,
      ).toBe(true);
    }
    // What the AI reads: each data word is in the row's sent column.
    const sent = rows.find((r) => r.surface === 'driver_support')?.asIs.toLowerCase() ?? '';
    for (const word of ['session', 'payment', 'reservation', 'station']) {
      if (!lower.includes(word)) continue;
      expect(sent.includes(word), `the driver note reads "${word}" the row does not send`).toBe(
        true,
      );
    }
  });
});
