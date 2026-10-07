// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { i18nReady } from './i18n/index';
import './index.css';
import { App } from './App';
import { applyTheme, type Theme } from './lib/theme';

const savedTheme = (localStorage.getItem('portal_theme') as Theme | null) ?? 'light';
applyTheme(savedTheme);

const root = document.getElementById('root');
if (root == null) {
  throw new Error('Root element not found');
}

function renderApp(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Render after the saved language is active. A failed locale load still renders (in English).
i18nReady.then(
  () => {
    renderApp(root);
  },
  (err: unknown) => {
    console.warn('Failed to load the saved language, rendering in English', err);
    renderApp(root);
  },
);
