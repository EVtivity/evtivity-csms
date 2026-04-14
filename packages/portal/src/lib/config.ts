// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

interface RuntimeConfig {
  apiUrl: string;
}

const runtimeConfig = (window as unknown as { __RUNTIME_CONFIG__?: RuntimeConfig })
  .__RUNTIME_CONFIG__;

export const API_BASE_URL: string =
  runtimeConfig?.apiUrl ?? (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';
