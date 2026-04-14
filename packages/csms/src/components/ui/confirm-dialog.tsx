// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './dialog';
import { Button } from './button';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmIcon?: React.ReactNode;
  onConfirm: (() => boolean) | (() => void);
  variant?: 'destructive' | 'default';
  cancelLabel?: string;
  isPending?: boolean;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmIcon,
  onConfirm,
  variant = 'destructive',
  cancelLabel,
  isPending = false,
  children,
}: ConfirmDialogProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{description}</p>
          {children}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            <X className="h-4 w-4" />
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            variant={variant}
            disabled={isPending}
            className="relative gap-1.5"
            onClick={() => {
              const result = onConfirm();
              if (result !== false) {
                onOpenChange(false);
              }
            }}
          >
            {isPending && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              </div>
            )}
            <span className={`inline-flex items-center gap-1.5 ${isPending ? 'invisible' : ''}`}>
              {confirmIcon}
              {confirmLabel}
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
