// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Eye, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/** The Customize button of the dashboard header (Live view). */
export function DashboardCustomizeButton({
  editing,
  onEditingChange,
}: {
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const label = editing ? t('dashboard.doneCustomizing') : t('dashboard.customize');
  return (
    <Tooltip content={label} side="left">
      <Button
        type="button"
        size="icon"
        variant={editing ? 'default' : 'outline'}
        aria-label={label}
        aria-pressed={editing}
        onClick={() => {
          onEditingChange(!editing);
        }}
      >
        {editing ? <Check className="h-4 w-4" /> : <SlidersHorizontal className="h-4 w-4" />}
      </Button>
    </Tooltip>
  );
}

/**
 * The bar shown while the dashboard is customized: the hidden widgets the
 * user may see, each with a Show button, and Reset Layout.
 */
export function DashboardCustomizeBar({
  hidden,
  onShow,
  onReset,
  isResetting,
}: {
  hidden: Array<{ id: string; name: string }>;
  onShow: (id: string) => void;
  onReset: () => void;
  isResetting: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border bg-muted/40 p-4 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 space-y-2">
        <p className="text-sm text-muted-foreground">{t('dashboard.customizeHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t('dashboard.hiddenWidgets')}</span>
          {hidden.length === 0 ? (
            <span className="text-sm text-muted-foreground">{t('dashboard.noHiddenWidgets')}</span>
          ) : (
            hidden.map((w) => (
              <Button
                key={w.id}
                type="button"
                variant="outline"
                size="xs"
                aria-label={t('dashboard.showWidget', { name: w.name })}
                onClick={() => {
                  onShow(w.id);
                }}
              >
                <Eye className="h-3.5 w-3.5" />
                {w.name}
              </Button>
            ))
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        className="shrink-0"
        disabled={isResetting}
        onClick={() => {
          setConfirmReset(true);
        }}
      >
        <RotateCcw className="h-4 w-4" />
        {t('dashboard.resetLayout')}
      </Button>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t('dashboard.resetLayoutTitle')}
        description={t('dashboard.resetLayoutDescription')}
        confirmLabel={t('dashboard.resetLayout')}
        variant="default"
        isPending={isResetting}
        onConfirm={onReset}
      />
    </div>
  );
}
