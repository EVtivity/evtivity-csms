// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Height of the 3D layout stage (and its loading placeholder): the viewport
 * height below the page header, tab bar and tab title, so the lot fills the
 * content area, and at least 420 px on phones and 580 px from `sm`.
 */
export const STAGE_HEIGHT_CLASS =
  'h-[max(420px,calc(100dvh-18rem))] sm:h-[max(580px,calc(100dvh-20rem))]';
