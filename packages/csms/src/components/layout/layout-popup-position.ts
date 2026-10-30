// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Where the station popup of the site layout goes, in the 2D and the 3D view:
// beside the station (right of it, else left of it), vertically centered on
// it, and always inside the visible part of its container.

export interface PopupRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PopupBounds {
  /** The visible area, in the container's coordinates (scroll offsets included). */
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Space between the popup and the container edge, in px. */
export const POPUP_MARGIN = 12;

export function layoutPopupPosition(
  anchor: PopupRect,
  size: { width: number; height: number },
  bounds: PopupBounds,
  gap: number,
): { left: number; top: number } {
  const minLeft = bounds.left + POPUP_MARGIN;
  const maxLeft = bounds.left + bounds.width - size.width - POPUP_MARGIN;
  let left = anchor.right + gap;
  if (left > maxLeft) left = anchor.left - size.width - gap;
  left = Math.max(minLeft, Math.min(left, maxLeft));
  const minTop = bounds.top + POPUP_MARGIN;
  const maxTop = bounds.top + bounds.height - size.height - POPUP_MARGIN;
  const center = (anchor.top + anchor.bottom) / 2;
  const top = Math.max(minTop, Math.min(center - size.height / 2, maxTop));
  return { left, top };
}

/** Places the popup element beside the anchor. */
export function placeLayoutPopup(
  popup: HTMLElement,
  anchor: PopupRect,
  bounds: PopupBounds,
  gap: number,
): void {
  const { left, top } = layoutPopupPosition(
    anchor,
    { width: popup.offsetWidth, height: popup.offsetHeight },
    bounds,
    gap,
  );
  popup.style.left = `${String(left)}px`;
  popup.style.top = `${String(top)}px`;
}
