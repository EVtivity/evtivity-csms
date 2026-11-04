// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The size classes of the overlay chips on the 3D site layout (the charging
 * summary and the Live OCPP Commands button), so the chips stack at one
 * height, padding, radius and type size at every width.
 */
export const LAYOUT_CHIP_FRAME_CLASS =
  'pointer-events-auto inline-flex max-w-full items-center rounded-md border bg-card px-1 py-0.5 text-xs font-semibold shadow-xs';

/** One pressable item inside a chip frame. */
export const LAYOUT_CHIP_ITEM_CLASS =
  'inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent';

/** An icon inside a chip item: the height of the text-xs line, so the chip keeps its height. */
export const LAYOUT_CHIP_ICON_CLASS = 'h-4 w-4 shrink-0';
