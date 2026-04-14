// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  envDir: path.resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          charts: ['apexcharts', 'react-apexcharts'],
          ui: ['lucide-react'],
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
      '/health': {
        target: `http://localhost:${process.env['API_PORT'] || '7102'}`,
        changeOrigin: true,
      },
    },
  },
});
