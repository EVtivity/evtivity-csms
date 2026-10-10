// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Live contract run (TC-AI-P-LIVE-OA), opt-in only:
//   AI_LIVE=openai OPENAI_EVTIVITY_API_KEY=... npx vitest run --config vitest.workspace.ts \
//     --project @evtivity/api-ai-live packages/api/src/services/ai/__contract__/openai.live.test.ts
// Skips without the key. The key is read here only and never logged or stored.

import { registerLiveContract } from './live-suite.js';
import { openaiTarget } from './targets/index.js';

registerLiveContract('P-LIVE-OA', openaiTarget, process.env.OPENAI_EVTIVITY_API_KEY);
