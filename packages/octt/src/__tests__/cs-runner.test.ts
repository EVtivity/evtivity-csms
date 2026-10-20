// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CsTestCase, CsTestCaseResult } from '../cs-types.js';

const registry: CsTestCase[] = [];
vi.mock('../cs-registry.js', () => ({ getCsRegistry: () => registry }));

const executeCsTest = vi.fn();
const closeCsSql = vi.fn().mockResolvedValue(undefined);
vi.mock('../cs-executor.js', () => ({
  executeCsTest: (...args: unknown[]) => executeCsTest(...args) as unknown,
  closeCsSql: () => closeCsSql() as unknown,
}));

vi.mock('../pics/index.js', () => ({ getNotApplicable: () => null }));

const { runCsTests } = await import('../cs-runner.js');

function testCase(id: string, version: CsTestCase['version']): CsTestCase {
  return { id, name: id, module: 'B', version, sut: 'cs' } as CsTestCase;
}

function passed(tc: CsTestCase): CsTestCaseResult {
  return {
    testId: tc.id,
    testName: tc.name,
    module: tc.module,
    version: tc.version,
    result: { status: 'passed', durationMs: 1, steps: [] },
  };
}

describe('runCsTests', () => {
  beforeEach(() => {
    registry.length = 0;
    executeCsTest.mockReset();
    closeCsSql.mockClear();
  });

  it('runs the cases of the selected version and counts their results', async () => {
    registry.push(testCase('TC_A', 'ocpp2.1'), testCase('TC_A', 'ocpp2.0.1'));
    executeCsTest.mockImplementation((tc: CsTestCase) => Promise.resolve(passed(tc)));
    const results: CsTestCaseResult[] = [];

    const summary = await runCsTests({ serverUrl: '', version: 'ocpp2.0.1', sut: 'cs' }, (r) =>
      results.push(r),
    );

    expect(summary).toMatchObject({ total: 1, passed: 1 });
    expect(results.map((r) => r.version)).toEqual(['ocpp2.0.1']);
    expect(closeCsSql).toHaveBeenCalledOnce();
  });

  it('starts no new case after an abort, lets the running one finish, then throws', async () => {
    registry.push(testCase('TC_1', 'ocpp2.1'), testCase('TC_2', 'ocpp2.1'));
    const controller = new AbortController();
    executeCsTest.mockImplementation((tc: CsTestCase) => {
      controller.abort(new Error('shutdown'));
      return Promise.resolve(passed(tc));
    });
    const results: CsTestCaseResult[] = [];

    await expect(
      runCsTests({ serverUrl: '', sut: 'cs', concurrency: 1, signal: controller.signal }, (r) =>
        results.push(r),
      ),
    ).rejects.toThrow('OCTT CS run aborted');

    expect(executeCsTest).toHaveBeenCalledOnce();
    expect(results.map((r) => r.testId)).toEqual(['TC_1']);
    expect(closeCsSql).toHaveBeenCalledOnce();
  });
});
