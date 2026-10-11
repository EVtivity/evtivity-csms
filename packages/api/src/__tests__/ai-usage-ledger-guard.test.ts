// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * TC-AI-US-01 guard: every model call path records its usage in the ledger,
 * and `recordAiUsage()` is the only writer of the ledger.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const SCANNED = ['packages/api/src', 'packages/worker/src', 'packages/services/src'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === '__integration__' || name === 'generated') continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

const files = SCANNED.flatMap((d) => sourceFiles(join(ROOT, d))).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

/** A model call on a provider adapter (`AiAdapter.stream` / `AiAdapter.complete`). */
const MODEL_CALL = /\badapter\.(stream|complete)\(/;
/** Recording in the same file: the ledger writer itself or the turn hook. */
const RECORDS = /\brecordAiUsage\(|\bhooks\.recordUsage\(/;

/**
 * Files whose model call is recorded by their caller, with the caller and the
 * marker that proves it records that call.
 */
const RECORDED_BY_CALLER: Record<string, { caller: string; marker: RegExp }> = {
  'packages/api/src/services/ai/engine/router.ts': {
    caller: 'packages/api/src/services/ai/engine/turn.ts',
    marker: /if \(routed\.called\)[\s\S]{0,400}recordTurnUsage\(/,
  },
};

describe('AI usage ledger guard (TC-AI-US-01)', () => {
  it('TC-AI-US-01 every file with a model call records its usage, itself or through its caller', () => {
    const callers = files.filter((f) => MODEL_CALL.test(f.text));
    expect(callers.length).toBeGreaterThan(0);
    for (const file of callers) {
      const delegated = RECORDED_BY_CALLER[file.path];
      if (delegated === undefined) {
        expect(RECORDS.test(file.text), `${file.path} calls a model without recording usage`).toBe(
          true,
        );
        continue;
      }
      const caller = files.find((f) => f.path === delegated.caller);
      expect(caller, delegated.caller).toBeDefined();
      expect(
        delegated.marker.test(caller?.text ?? ''),
        `${delegated.caller} records ${file.path}`,
      ).toBe(true);
      expect(/\brecordAiUsage\(/.test(caller?.text ?? '')).toBe(true);
    }
  });

  it('TC-AI-US-01 recordAiUsage is the only writer of ai_usage_ledger and ai_budget_notices', () => {
    const all = [
      ...files,
      ...sourceFiles(join(ROOT, 'packages/database/src')).map((path) => ({
        path: relative(ROOT, path),
        text: readFileSync(path, 'utf8'),
      })),
    ];
    const writers = all
      .filter((f) =>
        /insert\((aiUsageLedger|aiBudgetNotices)\)|INSERT INTO "?(ai_usage_ledger|ai_budget_notices)|update\((aiUsageLedger|aiBudgetNotices)\)|delete\((aiUsageLedger|aiBudgetNotices)\)/.test(
          f.text,
        ),
      )
      .map((f) => f.path);
    expect(writers).toEqual(['packages/database/src/lib/ai-usage.ts']);
  });

  it('the turn runner records after every model call', () => {
    const runner = files.find((f) => f.path.endsWith('services/ai/engine/turn-runner.ts'));
    const text = runner?.text ?? '';
    const call = text.indexOf('input.adapter.stream(');
    const record = text.indexOf('await hooks.recordUsage(');
    const firstReturnAfterCall = text.indexOf(
      "if (errorCode !== undefined) return end('error'",
      call,
    );
    expect(call).toBeGreaterThan(0);
    // Recorded before the first exit that follows the call.
    expect(record).toBeGreaterThan(call);
    expect(record).toBeLessThan(firstReturnAfterCall);
    // And before the message save, so a failed save does not lose spent tokens.
    expect(record).toBeLessThan(text.indexOf('await hooks.saveAssistantMessage(', call));
  });
});
