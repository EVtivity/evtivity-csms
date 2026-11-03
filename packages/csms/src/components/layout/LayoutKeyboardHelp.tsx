// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The keys and the mouse and trackpad gestures of the 3D layout stage. Always in the DOM: the stage's
// aria-describedby points at it, and the Keyboard button shows it as a panel.

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const ROWS = ['move', 'rotate', 'tilt', 'zoom', 'fit', 'faster'] as const;
const POINTER_ROWS = ['pointerRotate', 'pointerPan', 'pointerZoom'] as const;

function KeyList({
  rows,
}: {
  rows: readonly ((typeof ROWS)[number] | (typeof POINTER_ROWS)[number])[];
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map((row) => (
        <div key={row} className="contents">
          <dt className="font-medium">{t(`sites.layoutView.keyboard.${row}`)}</dt>
          <dd className="text-muted-foreground">{t(`sites.layoutView.keyboard.${row}Keys`)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LayoutKeyboardHelp({
  id,
  visible,
  editing,
}: {
  id: string;
  visible: boolean;
  editing: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      id={id}
      data-testid="site-layout-keyboard-help"
      className={cn(
        visible
          ? 'absolute right-3 top-12 z-[900] w-72 max-w-[calc(100%-24px)] space-y-2 rounded-lg border bg-card/95 p-3 text-sm shadow-lg backdrop-blur-xs'
          : 'sr-only',
      )}
    >
      <p className="font-semibold">{t('sites.layoutView.keyboard.title')}</p>
      <KeyList rows={ROWS} />
      <p className="text-xs text-muted-foreground">{t('sites.layoutView.keyboard.focusHint')}</p>
      <p className="font-semibold">{t('sites.layoutView.keyboard.pointerTitle')}</p>
      <KeyList rows={POINTER_ROWS} />
      {editing && (
        <p className="text-xs text-muted-foreground">{t('sites.layoutView.keyboard.editNote')}</p>
      )}
    </div>
  );
}
