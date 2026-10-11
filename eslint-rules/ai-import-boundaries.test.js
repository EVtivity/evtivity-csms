// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Runs the import rules exactly as eslint.config.js configures them for a file,
// so a config change that drops a restriction fails here.

import { resolve } from 'node:path';
import { ESLint, RuleTester } from 'eslint';
import { builtinRules } from 'eslint/use-at-your-own-risk';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const repoRoot = resolve(import.meta.dirname, '..');
const eslint = new ESLint({ cwd: repoRoot });

async function ruleOptions(file, rule) {
  const config = await eslint.calculateConfigForFile(resolve(repoRoot, file));
  const setting = config.rules?.[rule];
  return Array.isArray(setting) ? setting.slice(1) : [];
}

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

const aiOptions = await ruleOptions('packages/ai/src/core/types.ts', 'no-restricted-imports');
const aiProviderOptions = await ruleOptions(
  'packages/ai/src/providers/anthropic/adapter.ts',
  'no-restricted-imports',
);
const libOptions = await ruleOptions('packages/lib/src/ai-config.ts', 'no-restricted-imports');
const sdkOptions = await ruleOptions(
  'packages/worker/src/index.ts',
  '@typescript-eslint/no-restricted-imports',
);
const sdkOptionsInAdapter = await ruleOptions(
  'packages/ai/src/providers/anthropic/adapter.ts',
  '@typescript-eslint/no-restricted-imports',
);

describe('TC-AI-PK-04 eslint.config.js import boundaries', () => {
  it('TC-AI-PK-04 configures the rules for @evtivity/ai and the provider SDKs', () => {
    expect(aiOptions).toHaveLength(1);
    expect(aiProviderOptions).toEqual(aiOptions);
    expect(libOptions).toHaveLength(1);
    expect(sdkOptions).toHaveLength(1);
    expect(sdkOptionsInAdapter).toEqual([]);
  });
});

const APP_PACKAGES = [
  '@evtivity/api',
  '@evtivity/api/src/app.js',
  '@evtivity/ocpp',
  '@evtivity/ocpi',
  '@evtivity/worker',
  '@evtivity/css/ocpp-client',
  '@evtivity/database',
  '@evtivity/services/ocpp-command',
  '@evtivity/payments',
];

ruleTester.run(
  'TC-AI-PK-04 @evtivity/ai imports no app package',
  builtinRules.get('no-restricted-imports'),
  {
    valid: [
      "import { createLogger } from '@evtivity/lib';",
      "import { aiStreamEventSchema } from '@evtivity/lib/ai-stream';",
      "import Anthropic from '@anthropic-ai/sdk';",
      "import { collectAiStream } from '../../core/collect.js';",
    ].map((code) => ({ code, options: aiOptions })),
    invalid: APP_PACKAGES.map((spec) => ({
      code: `import x from '${spec}';`,
      options: aiOptions,
      errors: 1,
    })),
  },
);

ruleTester.run(
  'TC-AI-PK-04 provider SDKs only inside packages/ai/src/providers/<id>/',
  tseslint.plugin.rules['no-restricted-imports'],
  {
    valid: [
      "import { getProviderRegistry } from '@evtivity/ai/providers';",
      "import { z } from 'zod';",
    ].map((code) => ({ code, options: sdkOptions })),
    invalid: [
      "import Anthropic from '@anthropic-ai/sdk';",
      "import OpenAI from 'openai';",
      "import type { ChatCompletionChunk } from 'openai/resources/chat/completions';",
      "import { GoogleGenAI } from '@google/genai';",
      "import { GoogleGenerativeAI } from '@google/generative-ai';",
    ].map((code) => ({ code, options: sdkOptions, errors: 1 })),
  },
);

ruleTester.run(
  'TC-AI-PK-04 @evtivity/lib does not import @evtivity/ai',
  builtinRules.get('no-restricted-imports'),
  {
    valid: ["import { z } from 'zod';", "import { x } from './ai-config.js';"].map((code) => ({
      code,
      options: libOptions,
    })),
    invalid: ['@evtivity/ai/core', '@evtivity/ai/prompt', '@evtivity/api'].map((spec) => ({
      code: `import x from '${spec}';`,
      options: libOptions,
      errors: 1,
    })),
  },
);
