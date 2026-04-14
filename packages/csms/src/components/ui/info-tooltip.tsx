// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

export function InfoTooltip({
  content,
  children,
}: {
  content: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  return (
    <span
      ref={ref}
      className="hidden lg:inline-flex cursor-help"
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
