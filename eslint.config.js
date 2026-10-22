import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import headers from 'eslint-plugin-headers';
import { evtivityPlugin } from './eslint-rules/handle-caught-error.js';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['packages/octt/src/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/__integration__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Registered for every file so `--rule '{"evtivity/handle-caught-error":"error"}'`
  // works on any path. The rule itself is enabled only in the block below.
  {
    plugins: { headers, evtivity: evtivityPlugin },
    rules: {
      'headers/header-format': [
        'error',
        {
          source: 'string',
          style: 'line',
          content:
            'Copyright (c) 2024-2026 EVtivity. All rights reserved.\nSPDX-License-Identifier: BUSL-1.1',
          trailingNewlines: 2,
        },
      ],
    },
  },
  // Every catch rethrows the error, logs it with context, or shows it to the
  // user. An expected failure that carries no information uses a fallback
  // helper (tryParseJson, URL.parse) or a "// fail-open: <reason>" comment.
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    ignores: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx', '**/__integration__/**'],
    rules: {
      'evtivity/handle-caught-error': 'error',
    },
  },
  // Switches are the shared Toggle (frontend/ui.md, shared controls): no
  // hand-rolled role="switch" element outside components/ui.
  {
    files: ['packages/csms/src/**/*.tsx', 'packages/portal/src/**/*.tsx'],
    ignores: ['**/components/ui/**', '**/__tests__/**', '**/*.test.tsx'],
    rules: {
      'evtivity/no-raw-switch': 'error',
    },
  },
  // Inputs, selects and buttons take their height from the shared component
  // (frontend/ui.md, control heights): no height or vertical padding class
  // on them outside components/ui.
  {
    files: ['packages/csms/src/**/*.tsx', 'packages/portal/src/**/*.tsx'],
    ignores: ['**/components/ui/**', '**/__tests__/**', '**/*.test.tsx'],
    rules: {
      'evtivity/no-control-height-class': 'error',
    },
  },
  // Copying goes through the shared copy controls (frontend/ui.md, shared
  // controls): no navigator.clipboard outside components/ui.
  {
    files: [
      'packages/csms/src/**/*.ts',
      'packages/csms/src/**/*.tsx',
      'packages/portal/src/**/*.ts',
      'packages/portal/src/**/*.tsx',
    ],
    ignores: ['**/components/ui/**', '**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'evtivity/no-raw-clipboard': 'error',
    },
  },
  // Processes couple only through pub/sub and BullMQ (design principle P8).
  // Code shared by the API and the worker lives in lib, database, payments or
  // services, which import no app package. Integration tests may reuse the
  // API's test helpers.
  {
    files: [
      'packages/worker/src/**/*.ts',
      'packages/database/src/**/*.ts',
      'packages/payments/src/**/*.ts',
      'packages/services/src/**/*.ts',
    ],
    ignores: ['**/__integration__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@evtivity/api',
                '@evtivity/api/*',
                '@evtivity/ocpp',
                '@evtivity/ocpp/*',
                '@evtivity/ocpi',
                '@evtivity/ocpi/*',
                '@evtivity/worker',
                '@evtivity/worker/*',
              ],
              message:
                'Do not import another process package (P8). Move shared code to @evtivity/lib, @evtivity/database, @evtivity/payments, @evtivity/services or @evtivity/ai.',
            },
          ],
        },
      ],
    },
  },
  // lib is the base of every package: it imports no app package and not @evtivity/ai
  // or @evtivity/sim-providers, which depend on lib (an import back would be a cycle).
  {
    files: ['packages/lib/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@evtivity/api',
                '@evtivity/api/*',
                '@evtivity/ocpp',
                '@evtivity/ocpp/*',
                '@evtivity/ocpi',
                '@evtivity/ocpi/*',
                '@evtivity/worker',
                '@evtivity/worker/*',
                '@evtivity/ai',
                '@evtivity/ai/*',
                '@evtivity/sim-providers',
                '@evtivity/sim-providers/*',
              ],
              message:
                'Do not import another process package (P8), and not @evtivity/ai or @evtivity/sim-providers, which depend on lib. Move shared code to @evtivity/lib.',
            },
          ],
        },
      ],
    },
  },
  // @evtivity/ai (the provider-neutral AI core and the adapters) is shared by the
  // API and the worker and depends on @evtivity/lib only (design principle P8).
  {
    files: ['packages/ai/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@evtivity/(?!lib(/|$))',
              message:
                '@evtivity/ai imports no other workspace package but @evtivity/lib (P8): the API and the worker both load it.',
            },
          ],
        },
      ],
    },
  },
  // @evtivity/sim-providers (the SIM provider interface and adapters) is loaded by
  // the services package and depends on @evtivity/lib only (design principle P8).
  {
    files: ['packages/sim-providers/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@evtivity/(?!lib(/|$))',
              message:
                '@evtivity/sim-providers imports no other workspace package but @evtivity/lib (P8).',
            },
          ],
        },
      ],
    },
  },
  // OCPP commands go through publishOcppCommand (and awaitPubSubReply or
  // sendOcppCommandAndWait for a reply), so every caller sends the same
  // message shape (design principle P2). Only the lib module that owns the
  // channels names them.
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    ignores: [
      'packages/lib/src/ocpp-command-publish.ts',
      '**/__tests__/**',
      '**/*.test.ts',
      '**/__integration__/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value='ocpp_commands']",
          message:
            "Publish OCPP commands with publishOcppCommand from @evtivity/lib (or OCPP_COMMANDS_CHANNEL), not the 'ocpp_commands' literal.",
        },
        {
          selector: "Literal[value='ocpp_command_results']",
          message:
            "Wait for OCPP command results with awaitPubSubReply or sendOcppCommandAndWait (or OCPP_COMMAND_RESULTS_CHANNEL), not the 'ocpp_command_results' literal.",
        },
        {
          selector: 'TemplateElement[value.cooked=/^ocpp_command(s|_results)$/]',
          message: 'Use OCPP_COMMANDS_CHANNEL or OCPP_COMMAND_RESULTS_CHANNEL from @evtivity/lib.',
        },
      ],
    },
  },
  // Token authorization runs through the shared pipeline (packages/ocpp/src/authorization/):
  // OCPP code outside it records decisions with recordAuthorizeDecision, never
  // logAuthorizeAttempt (start.ts still wires setAuthorizeLogPubSub), and the
  // pipeline stays version-neutral (no generated OCPP types).
  {
    files: ['packages/ocpp/src/**/*.ts'],
    ignores: ['packages/ocpp/src/authorization/**', '**/__tests__/**', '**/__integration__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: 'authorization/authorize-log\\.js$',
              importNames: ['logAuthorizeAttempt'],
              message:
                'Record authorize decisions with recordAuthorizeDecision from authorization/authorize-token.js.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ocpp/src/authorization/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/generated/**'],
              message: 'The authorize pipeline is version-neutral: map OCPP types in the adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    // Playwright E2E code (private repo only) is type-checked by e2e/tsconfig.json,
    // which the per-package tsconfigs found by the project service do not include.
    files: ['e2e/**/*.ts', 'packages/*/e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './e2e/tsconfig.json',
      },
    },
  },
  // AI provider SDKs load only inside their adapter folder (packages/ai/src/providers/<name>/);
  // everything else talks to the neutral AiAdapter. TC-AI-PK-01 checks the per-folder mapping.
  // The typescript-eslint variant of the rule is used so this ban does not replace the
  // no-restricted-imports settings of the blocks above.
  {
    files: [
      'packages/*/src/**/*.ts',
      'packages/*/src/**/*.tsx',
      'packages/*/e2e/**/*.ts',
      'packages/*/scripts/**/*.ts',
    ],
    ignores: ['packages/ai/src/providers/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(@anthropic-ai/sdk|openai|@google/genai|@google/generative-ai)(/.*)?$',
              message:
                'Import AI provider SDKs only in packages/ai/src/providers/<name>/; use the AiAdapter from the provider registry (@evtivity/ai/providers).',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/generated/',
      'packages/codegen/.test-gen-*/',
      'eslint.config.js',
      'eslint-rules/',
      'vitest.workspace.ts',
      'vitest.integration.ts',
      'coverage/',
      'scripts/',
      'docker/',
      '**/vite.config.*',
      '**/drizzle.config.ts',
      'commitlint.config.cjs',
    ],
  },
);
