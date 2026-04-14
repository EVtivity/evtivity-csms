// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string | undefined;
  readonly VITE_PORTAL_URL: string | undefined;
  readonly VITE_CSMS_URL: string | undefined;
  readonly VITE_OCPP_URL: string | undefined;
  readonly VITE_CSMS_AUTO_LOGIN: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
