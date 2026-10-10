// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Live contract run (TC-AI-P-LIVE-GE), opt-in only:
//   AI_LIVE=gemini GEMINI_EVTIVITY_API_KEY=... npx vitest run --config vitest.workspace.ts \
//     --project @evtivity/api-ai-live packages/api/src/services/ai/__contract__/gemini.live.test.ts
// Skips without the key. The key is read here only and never logged or stored.

import { registerLiveContract } from './live-suite.js';
import { geminiTarget } from './targets/index.js';

registerLiveContract('P-LIVE-GE', geminiTarget, process.env.GEMINI_EVTIVITY_API_KEY);
