// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PORTAL_AUTO_LOGIN: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
