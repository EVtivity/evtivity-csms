// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';

// Open layers (dialogs, the AI panel) in the order they opened. Escape goes to
// the topmost one only, so a confirm dialog inside a panel closes before the
// panel does.
const openLayers: symbol[] = [];

/**
 * Registers a dismissable layer while mounted: Escape anywhere on the page
 * calls `onEscape` when this layer is the topmost one, and is consumed
 * (`preventDefault`) so the layer below does not act on it too. Returns a
 * function that tells whether the layer is the topmost one, for checks such
 * as a click outside.
 */
export function useEscapeLayer(onEscape: () => void): () => boolean {
  const latest = React.useRef(onEscape);
  React.useEffect(() => {
    latest.current = onEscape;
  });
  const token = React.useRef<symbol | null>(null);

  React.useEffect(() => {
    const own = Symbol('layer');
    token.current = own;
    openLayers.push(own);
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (openLayers[openLayers.length - 1] !== own) return;
      e.preventDefault();
      latest.current();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const index = openLayers.indexOf(own);
      if (index !== -1) openLayers.splice(index, 1);
      token.current = null;
    };
  }, []);

  return React.useCallback(
    () => token.current !== null && openLayers[openLayers.length - 1] === token.current,
    [],
  );
}
