// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

export function InfoTooltip({
  content,
  children,
  showOnMobile = false,
}: {
  content: React.ReactNode;
  children?: React.ReactNode;
  /** When true, render the wrapper on every viewport. Used by elements that
   * have standalone value beyond the tooltip (e.g. day-over-day trend arrows)
   * where hiding them on mobile loses the indicator entirely. Default false
   * keeps the info-icon usage hidden on touch viewports where hover is
   * inaccessible. */
  showOnMobile?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const wrapperClass = showOnMobile
    ? 'inline-flex cursor-help'
    : 'hidden lg:inline-flex cursor-help';

  return (
    <span
      ref={ref}
      className={wrapperClass}
      onMouseEnter={() => {
        const rect = ref.current?.getBoundingClientRect();
        if (rect != null) setPos({ x: rect.left + rect.width / 2, y: rect.top });
      }}
      onMouseLeave={() => {
        setPos(null);
      }}
    >
      {children ?? <Info className="h-3.5 w-3.5 text-muted-foreground" />}
      {pos != null &&
        createPortal(
          <div
            className="pointer-events-none fixed rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg border z-[9999]"
            style={{ left: pos.x, top: pos.y - 6, transform: 'translate(-50%, -100%)' }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
