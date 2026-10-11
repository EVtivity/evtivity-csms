// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { CONTRACT_CASES } from '../__contract__/cases.js';
import { contractCaseApplies, contractTestName, runContractCase } from '../__contract__/harness.js';
import { CONTRACT_TARGETS } from '../__contract__/targets/index.js';
import { PROVIDER_IDS } from '../core/types.js';

it('TC-AI-PK-02 the contract suite runs from @evtivity/ai for every provider', () => {
  expect(CONTRACT_TARGETS.map((t) => t.provider).sort()).toEqual([...PROVIDER_IDS].sort());
  expect(CONTRACT_CASES.length).toBeGreaterThan(0);
});

// The shared provider contract, once per adapter, against the recorded wire
// fixtures on the mock provider server.
for (const target of CONTRACT_TARGETS) {
  describe(`${target.provider} adapter contract (${target.model})`, () => {
    for (const c of CONTRACT_CASES) {
      it.skipIf(!contractCaseApplies(target, c))(contractTestName(c), () =>
        runContractCase(target, c),
      );
    }
  });
}
