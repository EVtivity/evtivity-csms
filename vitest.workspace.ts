import { defineConfig } from 'vitest/config';
import path from 'node:path';

const workspaceAliases = {
  '@evtivity/lib': path.resolve(__dirname, 'packages/lib/src/index.ts'),
  '@evtivity/database': path.resolve(__dirname, 'packages/database/src/index.ts'),
  '@evtivity/configs': path.resolve(__dirname, 'packages/configs/src/index.ts'),
  '@evtivity/ocpp': path.resolve(__dirname, 'packages/ocpp/src/index.ts'),
};

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
          alias: {
            '@evtivity/database/src/lib/id.js': path.resolve(
              __dirname,
              'packages/database/src/lib/id.ts',
            ),
            ...workspaceAliases,
            '@evtivity/css/ocpp-client': path.resolve(__dirname, 'packages/css/src/ocpp-client.ts'),
          },
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
          alias: {
            ...workspaceAliases,
            '@': path.resolve(__dirname, 'packages/portal/src'),
          },
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
          alias: {
            ...workspaceAliases,
            '@': path.resolve(__dirname, 'packages/csms/src'),
          },
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
