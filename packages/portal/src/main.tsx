// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n/index.ts';
import './index.css';
import { App } from './App';
import { applyTheme, type Theme } from './lib/theme';

const savedTheme = (localStorage.getItem('portal_theme') as Theme | null) ?? 'light';
applyTheme(savedTheme);

const root = document.getElementById('root');
if (root == null) {
  throw new Error('Root element not found');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
