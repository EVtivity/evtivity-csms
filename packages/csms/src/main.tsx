// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { i18nReady } from './i18n';
import { App } from './App';
import { applyTheme, resolveInitialTheme } from './lib/theme';

applyTheme(resolveInitialTheme());

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
