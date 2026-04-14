// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export interface TooltipProps {
  content: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactNode;
  className?: string;
}

function Tooltip({ content, side = 'top', children, className }: TooltipProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [coords, setCoords] = React.useState({ top: 0, left: 0 });
  const triggerRef = React.useRef<HTMLSpanElement>(null);
  const tooltipRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open || triggerRef.current == null) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const tooltipEl = tooltipRef.current;
    const tw = tooltipEl?.offsetWidth ?? 0;
    const th = tooltipEl?.offsetHeight ?? 0;
    const gap = 8;

    let top = 0;
    let left = 0;

    switch (side) {
      case 'bottom':
        top = rect.bottom + gap;
        left = rect.left + rect.width / 2 - tw / 2;
        break;
      case 'left':
        top = rect.top + rect.height / 2 - th / 2;
        left = rect.left - tw - gap;
        break;
      case 'right':
        top = rect.top + rect.height / 2 - th / 2;
        left = rect.right + gap;
        break;
      default:
        top = rect.top - th - gap;
        left = rect.left + rect.width / 2 - tw / 2;
        break;
    }

    setCoords({ top, left });
  }, [open, side]);

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-flex"
        onMouseEnter={() => {
          setOpen(true);
        }}
        onMouseLeave={() => {
          setOpen(false);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
        }}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className={cn(
              'fixed z-50 max-w-xs rounded-md bg-foreground px-3 py-1.5 text-xs text-background animate-fade-in',
              className,
            )}
            style={{ top: coords.top, left: coords.left }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}

export { Tooltip };
