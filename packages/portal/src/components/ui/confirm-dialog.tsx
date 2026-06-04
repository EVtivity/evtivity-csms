// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Button } from './button';
import { Spinner } from '@/components/ui/spinner';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  /**
   * Override the cancel button label. Defaults to `t('common.cancel')`.
   * Useful when the dialog is itself confirming a "Cancel X" action and
   * the standard "Cancel" label would be ambiguous (e.g. cancel-reservation
   * dialog uses "Keep" so it's clear which way each button goes).
   */
  cancelLabel?: string;
  // Returning false (or a Promise resolving to false) prevents the dialog
  // from auto-closing -- useful when the caller wants to keep the dialog
  // open with `isPending` until an async side effect completes. Returning
  // anything else (including no return value) auto-closes the dialog.
  onConfirm: () => unknown;
  variant?: 'destructive' | 'default';
  isPending?: boolean;
  hideCancel?: boolean;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  variant = 'default',
  isPending = false,
  hideCancel = false,
  children,
}: ConfirmDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          if (isPending) return;
          onOpenChange(false);
        }}
      />
      <div className="relative z-50 w-full max-w-sm mx-4 rounded-lg border bg-card p-6 shadow-lg space-y-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        {children}
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="flex justify-end gap-2">
          {!hideCancel && (
            <Button
              variant="outline"
              disabled={isPending}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {cancelLabel ?? t('common.cancel')}
            </Button>
          )}
          <Button
            variant={variant}
            disabled={isPending}
            onClick={() => {
              void (async () => {
                const result = await onConfirm();
                if (result === false) return;
                onOpenChange(false);
              })();
            }}
          >
            {isPending && <Spinner className="mr-2 h-4 w-4" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
