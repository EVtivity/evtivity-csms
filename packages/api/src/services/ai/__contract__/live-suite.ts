// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Registers the live contract cases (TC-AI-P-LIVE-*) for one target. Test
 * only: the `*.live.test.ts` files call it, and they run only in the
 * `@evtivity/api-ai-live` vitest project (`AI_LIVE` set), never in `npm test`.
 *
 * The caller reads the key from the environment and passes it in; it is
 * never logged or written. `AI_LIVE_REPORT` names a file that receives the
 * observations (tool-call counts, state presence), which hold no key.
 */

import { writeFileSync } from 'node:fs';
import { afterAll, describe, it } from 'vitest';
import { CONTRACT_CASES, contractObservations } from './cases.js';
import type { AdapterContractTarget } from './cases.js';
import { contractCaseApplies, contractTestName, runContractCase } from './harness.js';

export function registerLiveContract(
  caseId: string,
  target: AdapterContractTarget,
  apiKey: string | undefined,
  extra: (key: string) => void = () => undefined,
): void {
  const live = apiKey !== undefined && apiKey !== '' ? { apiKey } : undefined;
  describe.skipIf(live === undefined)(`TC-AI-${caseId} ${target.provider} live contract`, () => {
    const options = { live: live ?? { apiKey: '' } };
    for (const c of CONTRACT_CASES) {
      it.skipIf(!contractCaseApplies(target, c, options))(contractTestName(c), () =>
        runContractCase(target, c, options),
      );
    }
    extra(live?.apiKey ?? '');
    afterAll(() => {
      const report = process.env.AI_LIVE_REPORT;
      if (report !== undefined && report !== '') {
        writeFileSync(report, `${JSON.stringify(contractObservations, null, 2)}\n`);
      }
    });
  });
}
