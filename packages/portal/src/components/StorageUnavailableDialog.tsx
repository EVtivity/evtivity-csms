// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getApiErrorCode } from '@/lib/api';

/** The API error code of an upload route while file storage is not set up. */
export const STORAGE_NOT_CONFIGURED_CODE = 'STORAGE_NOT_CONFIGURED';

/** True when a request failed because file storage is not set up. */
export function isStorageNotConfiguredError(err: unknown): boolean {
  return getApiErrorCode(err) === STORAGE_NOT_CONFIGURED_CODE;
}

interface StorageUnavailableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Tells the driver that files cannot be uploaded right now and to try again
 * later or contact support. It names no settings: drivers cannot fix it.
 */
export function StorageUnavailableDialog({
  open,
  onOpenChange,
}: StorageUnavailableDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('storageUnavailable.title')}
      description={t('storageUnavailable.description')}
      confirmLabel={t('common.ok')}
      hideCancel
      onConfirm={() => undefined}
    />
  );
}

export interface StorageGuard {
  /** Runs `openPicker` while storage is set up, else opens the dialog instead. */
  guard: (storageEnabled: boolean, openPicker: () => void) => void;
  /** Opens the dialog for a storage error; returns whether it did. */
  handleUploadError: (err: unknown) => boolean;
  /** The dialog element: render it once in the component that uses the guard. */
  dialog: React.JSX.Element;
}

/** The storage check of every portal upload control. */
export function useStorageGuard(): StorageGuard {
  const [open, setOpen] = useState(false);
  const guard = useCallback((storageEnabled: boolean, openPicker: () => void) => {
    if (storageEnabled) openPicker();
    else setOpen(true);
  }, []);
  const handleUploadError = useCallback((err: unknown) => {
    if (!isStorageNotConfiguredError(err)) return false;
    setOpen(true);
    return true;
  }, []);
  return {
    guard,
    handleUploadError,
    dialog: <StorageUnavailableDialog open={open} onOpenChange={setOpen} />,
  };
}
