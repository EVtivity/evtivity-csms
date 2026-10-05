import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import headers from 'eslint-plugin-headers';

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
  {
    plugins: { headers },
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
  // Processes couple only through pub/sub and BullMQ (design principle P8).
  // Code shared by the API and the worker lives in lib, database, payments or
  // services, which import no app package. Integration tests may reuse the
  // API's test helpers.
  {
    files: [
      'packages/worker/src/**/*.ts',
      'packages/lib/src/**/*.ts',
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
                'Do not import another process package (P8). Move shared code to @evtivity/lib, @evtivity/database, @evtivity/payments or @evtivity/services.',
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
  {
    files: ['packages/api/src/services/ai/anthropic-provider.ts'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off',
    },
  },
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/generated/',
      'eslint.config.js',
      'vitest.workspace.ts',
      'vitest.integration.ts',
      'coverage/',
      'scripts/',
      'internal-scripts/',
      '**/vite.config.*',
      '**/drizzle.config.ts',
      'commitlint.config.cjs',
    ],
  },
);
