// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { AdapterContractTarget } from '../cases.js';
import { anthropicTarget } from './anthropic.js';
import { deepseekTarget } from './deepseek.js';
import { geminiTarget } from './gemini.js';
import { openaiTarget } from './openai.js';

/** One contract target per adapter, in `PROVIDER_IDS` order. */
export const CONTRACT_TARGETS: readonly AdapterContractTarget[] = [
  anthropicTarget,
  openaiTarget,
  geminiTarget,
  deepseekTarget,
];

export { anthropicTarget, deepseekTarget, geminiTarget, openaiTarget };
