// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Live contract run (TC-AI-P-LIVE-DS), opt-in only:
//   AI_LIVE=deepseek DEEPSEEK_EVTIVITY_API_KEY=... npx vitest run --config vitest.workspace.ts \
//     --project @evtivity/api-ai-live packages/api/src/services/ai/__contract__/deepseek.live.test.ts
// Skips without the key. The key is read here only and never logged or stored
// (owner decision O5). It also lists the models, which settles the model ids.

import assert from 'node:assert/strict';
import { it } from 'vitest';
import { DEEPSEEK_DEFAULT_BASE_URL } from '../providers/deepseek/adapter.js';
import { contractObservations } from './cases.js';
import { registerLiveContract } from './live-suite.js';
import { deepseekTarget } from './targets/index.js';

registerLiveContract(
  'P-LIVE-DS',
  deepseekTarget,
  process.env.DEEPSEEK_EVTIVITY_API_KEY,
  (apiKey) => {
    it('TC-AI-P-LIVE-DS lists deepseek-flash and deepseek-v4-pro (GET /models)', async () => {
      const res = await fetch(`${DEEPSEEK_DEFAULT_BASE_URL}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(res.ok, true, `GET /models returned ${String(res.status)}`);
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      const ids = (body.data ?? []).map((m) => String(m.id));
      contractObservations['deepseek.models'] = ids;
      assert.ok(ids.includes('deepseek-flash'), 'deepseek-flash is not listed');
    });
  },
);
