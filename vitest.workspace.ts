import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Exact-match regexes: a plain string key is a prefix match, so '@evtivity/database'
// would also rewrite '@evtivity/database/src/lib/id.js' in projects that inherit it.
const workspaceAliases = Object.entries({
  '@evtivity/lib': 'packages/lib/src/index.ts',
  '@evtivity/database': 'packages/database/src/index.ts',
  '@evtivity/payments': 'packages/payments/src/index.ts',
  '@evtivity/configs': 'packages/configs/src/index.ts',
  '@evtivity/ocpp': 'packages/ocpp/src/index.ts',
  '@evtivity/octt': 'packages/octt/src/index.ts',
}).map(([pkg, file]) => ({
  find: new RegExp(`^${pkg.replace('/', '\\/')}$`),
  replacement: path.resolve(import.meta.dirname, file),
}));

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
      exclude: [
        '**/generated/**',
        '**/database/**',
        '**/index.ts',
        '**/lib/src/container.ts',
        '**/node_modules/**',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/plugins/**',
      ],
    },
    projects: [
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: '@evtivity/database',
          root: 'packages/database',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: '@evtivity/lib',
          root: 'packages/lib',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: '@evtivity/payments',
          root: 'packages/payments',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: '@evtivity/codegen',
          root: 'packages/codegen',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: '@evtivity/ocpp',
          root: 'packages/ocpp',
          include: ['src/**/*.test.ts'],
          exclude: ['src/__integration__/**'],
          env: {
            OCPP_PORT: '8080',
            SETTINGS_ENCRYPTION_KEY: 'test-encryption-key-32chars!!!!!',
            DATABASE_URL: 'postgres://evtivity:evtivity@localhost:5433/evtivity',
            REDIS_URL: 'redis://localhost:6379',
          },
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: '@evtivity/ocpi',
          root: 'packages/ocpi',
          include: ['src/**/*.test.ts'],
          exclude: ['src/__integration__/**'],
          env: {
            OCPI_PORT: '3002',
            SETTINGS_ENCRYPTION_KEY: 'test-encryption-key-32chars!!!!!',
            DATABASE_URL: 'postgres://evtivity:evtivity@localhost:5433/evtivity',
            REDIS_URL: 'redis://localhost:6379',
          },
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: '@evtivity/api',
          root: 'packages/api',
          include: ['src/**/*.test.ts'],
          exclude: ['src/__integration__/**'],
          env: {
            API_PORT: '3001',
            JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
            CORS_ORIGIN: 'http://localhost',
            SETTINGS_ENCRYPTION_KEY: 'test-encryption-key-32chars!!!!!',
            REDIS_URL: 'redis://localhost:6379',
            DATABASE_URL: 'postgres://evtivity:evtivity@localhost:5433/evtivity',
          },
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: '@evtivity/worker',
          root: 'packages/worker',
          include: ['src/**/*.test.ts'],
          exclude: ['src/__integration__/**'],
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: '@evtivity/css',
          root: 'packages/css',
          include: ['src/**/*.test.ts'],
          testTimeout: 15_000,
        },
      },
      {
        resolve: {
          alias: [
            {
              find: '@evtivity/database/src/lib/id.js',
              replacement: path.resolve(import.meta.dirname, 'packages/database/src/lib/id.ts'),
            },
            ...workspaceAliases,
            {
              find: '@evtivity/css/ocpp-client',
              replacement: path.resolve(import.meta.dirname, 'packages/css/src/ocpp-client.ts'),
            },
          ],
        },
        test: {
          name: '@evtivity/octt',
          root: 'packages/octt',
          include: ['src/**/*.test.ts'],
          exclude: ['src/__tests__/runner.test.ts'],
        },
      },
      {
        resolve: {
          alias: [
            ...workspaceAliases,
            { find: '@', replacement: path.resolve(import.meta.dirname, 'packages/portal/src') },
          ],
        },
        test: {
          name: '@evtivity/portal',
          root: 'packages/portal',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
      {
        resolve: {
          alias: [
            ...workspaceAliases,
            { find: '@', replacement: path.resolve(import.meta.dirname, 'packages/csms/src') },
          ],
        },
        test: {
          name: '@evtivity/csms',
          root: 'packages/csms',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
