// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useId } from 'react';
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
  /** The children and buttons sit in a form whose submit is the confirm button, so Enter confirms. */
  asForm?: boolean;
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
  asForm = false,
  children,
}: ConfirmDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();

  if (!open) return null;

  function confirm(): void {
    const result = onConfirm();
    // A synchronous confirm closes at once; an async one closes when it settles.
    if (!(result instanceof Promise)) {
      if (result !== false) onOpenChange(false);
      return;
    }
    void result.then((settled) => {
      if (settled !== false) onOpenChange(false);
    });
  }

  const body = (
    <>
      {children}
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {description}
      </p>
      <div className="flex justify-end gap-2">
        {!hideCancel && (
          <Button
            type="button"
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
          type={asForm ? 'submit' : 'button'}
          variant={variant}
          disabled={isPending}
          {...(asForm ? {} : { onClick: confirm })}
        >
          {isPending && <Spinner className="mr-2 h-4 w-4" />}
          {confirmLabel}
        </Button>
      </div>
    </>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-background/80 backdrop-blur-xs"
        onClick={() => {
          if (isPending) return;
          onOpenChange(false);
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative z-50 w-full max-w-sm mx-4 rounded-lg border bg-card p-6 shadow-lg space-y-4"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        {asForm ? (
          <form
            noValidate
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isPending) confirm();
            }}
          >
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </div>
  );
}
