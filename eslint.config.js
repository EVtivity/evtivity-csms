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
        projectService: {
          allowDefaultProject: ['packages/csms/src/lib/__tests__/*.ts'],
          defaultProject: './tsconfig.base.json',
        },
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
      'playwright.config.ts',
      '**/e2e/',
      'coverage/',
      'scripts/',
      'internal-scripts/',
      '**/postcss.config.js',
      '**/tailwind.config.*',
      '**/vite.config.*',
      '**/drizzle.config.ts',
      'commitlint.config.cjs',
    ],
  },
);
