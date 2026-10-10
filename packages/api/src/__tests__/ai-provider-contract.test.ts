// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it } from 'vitest';
import { CONTRACT_CASES } from '../services/ai/__contract__/cases.js';
import {
  contractCaseApplies,
  contractTestName,
  runContractCase,
} from '../services/ai/__contract__/harness.js';
import { CONTRACT_TARGETS } from '../services/ai/__contract__/targets/index.js';

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
