// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

interface RuntimeConfig {
  apiUrl: string;
  portalUrl: string;
  csmsUrl: string;
  ocppUrl: string;
}

const runtimeConfig = (window as unknown as { __RUNTIME_CONFIG__?: RuntimeConfig })
  .__RUNTIME_CONFIG__;

export const API_BASE_URL: string = runtimeConfig?.apiUrl || import.meta.env.VITE_API_URL || '';

export const PORTAL_BASE_URL: string =
  runtimeConfig?.portalUrl ||
  import.meta.env.VITE_PORTAL_URL ||
  `${window.location.protocol}//${window.location.hostname}:7101`;

export const OCPP_BASE_URL: string =
  runtimeConfig?.ocppUrl ||
  import.meta.env.VITE_OCPP_URL ||
  `ws://${window.location.hostname}:7103`;
