// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const rootPkg = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  envDir: path.resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    sourcemap: false,
    // The only chunks over 500 kB are ApexCharts and the rich-text editor, each a single
    // library loaded lazily by the pages that use it.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // Anchored paths: a loose '/react/' match pulled @tiptap/react (the whole editor)
        // into the startup chunk. Charts and the editor stay in their lazy page chunks.
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/,
              priority: 30,
            },
            { name: 'query', test: /node_modules[\\/]@tanstack[\\/]/, priority: 20 },
            { name: 'ui', test: /node_modules[\\/]lucide-react[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
  server: {
    port: parseInt(process.env['CSMS_PORT'] || '7100'),
    proxy: {
      '/v1': {
        target: `http://localhost:${process.env['API_PORT'] || '7102'}`,
        changeOrigin: true,
      },
    },
  },
});
