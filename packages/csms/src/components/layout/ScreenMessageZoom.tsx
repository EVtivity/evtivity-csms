// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A magnified copy of a charger screen beside the pointer while it hovers
// the screen in the 3D site layout (a tap on touch): the screen's frame, its
// text at a readable size and the station name. It takes no pointer events,
// so it never holds the hover, and it moves no camera. Keyboard and screen
// reader users get the same text in the station popup.

import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { SCREEN_MESSAGE } from './site-layout-grid';
import { placeLayoutPopup, type PopupBounds } from './layout-popup-position';
import {
  screenPlainText,
  type ScreenKind,
  type ScreenMessageSource,
} from './site-layout-screen-text';

/** Space between the pointer and the overlay, in px. */
export const SCREEN_ZOOM_GAP = 16;

export interface ScreenMessageZoomProps {
  /** The station's OCPP id, shown above the screen. */
  stationName: string;
  /** The screen text (`screenMessage.text` of the layout reply). */
  text: string;
  /** The charger model's screen, for its shape. */
  kind: ScreenKind;
  /** Where the pointer is, in the container's coordinates (px). */
  anchor: { x: number; y: number };
  /** The visible area of the container the overlay is placed in. */
  bounds: PopupBounds;
  /** Where the text comes from; shown under the screen when given. */
  source?: ScreenMessageSource | undefined;
}

/** The text size of the magnified screen: smaller for longer text, never below 14 px. */
export function screenZoomTextClass(text: string): string {
  const length = Array.from(text).length;
  if (length <= 60) return 'text-lg';
  if (length <= 160) return 'text-base';
  return 'text-sm';
}

export function ScreenMessageZoom({
  stationName,
  text,
  kind,
  anchor,
  bounds,
  source,
}: ScreenMessageZoomProps): React.JSX.Element {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const plain = screenPlainText(text);
  const { width, height } = SCREEN_MESSAGE[kind].canvas;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el == null) return;
    placeLayoutPopup(
      el,
      { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y },
      bounds,
      SCREEN_ZOOM_GAP,
    );
  }, [anchor.x, anchor.y, bounds, plain, kind]);

  return (
    <div
      ref={ref}
      role="tooltip"
      data-testid="screen-message-zoom"
      className="pointer-events-none absolute left-0 top-0 z-20 w-72 rounded-lg border bg-card p-3 text-card-foreground shadow-lg"
    >
      <p className="truncate text-sm font-medium">{stationName}</p>
      <p className="mb-2 text-xs text-muted-foreground">{t('sites.layoutView.screenZoomLabel')}</p>
      <div className="rounded-md border bg-muted p-1.5" data-testid="screen-message-zoom-frame">
        <div
          className="flex items-center justify-center overflow-hidden rounded-sm border bg-background px-3 py-2"
          style={{ aspectRatio: `${String(width)} / ${String(height)}` }}
        >
          <p
            className={cn(
              'whitespace-pre-line text-center font-semibold leading-tight text-foreground wrap-anywhere',
              screenZoomTextClass(plain),
            )}
          >
            {plain}
          </p>
        </div>
      </div>
      {source != null && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('sites.layoutView.screenSourceLabel', {
            source: t(`sites.layoutView.screenSource.${source}`),
          })}
        </p>
      )}
    </div>
  );
}
