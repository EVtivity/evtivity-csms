// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { getApiErrorCode } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';

/** The Settings tab where an administrator sets up file storage (S3). */
export const FILE_STORAGE_SETTINGS_PATH = '/settings?tab=integrations&sub=s3';

/** The API error code of an upload route while file storage is not set up. */
export const STORAGE_NOT_CONFIGURED_CODE = 'STORAGE_NOT_CONFIGURED';

/** True when a request failed because file storage is not set up. */
export function isStorageNotConfiguredError(err: unknown): boolean {
  return getApiErrorCode(err) === STORAGE_NOT_CONFIGURED_CODE;
}

function OpenStorageSettingsButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => {
        onOpen();
        void navigate(FILE_STORAGE_SETTINGS_PATH);
      }}
    >
      {t('storageUnavailable.openSettings')}
    </Button>
  );
}

interface StorageUnavailableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Tells the user that files cannot be uploaded because file storage is not
 * set up, and where an administrator sets it up. A user who can open and save
 * that Settings tab gets a button to it.
 */
export function StorageUnavailableDialog({
  open,
  onOpenChange,
}: StorageUnavailableDialogProps): React.JSX.Element | null {
  // The permission reads and the router are needed only while it is open.
  if (!open) return null;
  return <OpenStorageUnavailableDialog onOpenChange={onOpenChange} />;
}

function OpenStorageUnavailableDialog({
  onOpenChange,
}: Pick<StorageUnavailableDialogProps, 'onOpenChange'>): React.JSX.Element {
  const { t } = useTranslation();
  const canReadIntegrations = useHasPermission('settings.integrations:read');
  const canWriteSystem = useHasPermission('settings.system:write');
  const hasAllSiteAccess = useHasAllSiteAccess();
  const canOpenSettings = canReadIntegrations && canWriteSystem && hasAllSiteAccess;
  const path = [t('nav.settings'), t('settings.integrations'), t('settings.s3')].join(' > ');
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="storage-unavailable-dialog">
        <DialogHeader>
          <DialogTitle>{t('storageUnavailable.title')}</DialogTitle>
          <DialogDescription>{t('storageUnavailable.description', { path })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {canOpenSettings && (
            <OpenStorageSettingsButton
              onOpen={() => {
                onOpenChange(false);
              }}
            />
          )}
          <Button
            type="button"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.ok')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface StorageGuard {
  /** False only once the API reported that file storage is not set up. */
  storageEnabled: boolean;
  /** Runs `openPicker` while storage is set up, else opens the dialog instead. */
  guard: (openPicker: () => void) => void;
  /** Opens the dialog for a storage error; returns whether it did. */
  handleUploadError: (err: unknown) => boolean;
  /** Opens the dialog. */
  showDialog: () => void;
  /** The dialog element: render it once in the component that uses the guard. */
  dialog: React.JSX.Element;
}

/**
 * The storage check of every upload control. `configured` overrides the
 * `fileStorageEnabled` flag of `GET /v1/portal/features` (the support case
 * page reads its own endpoint); unknown counts as set up, and an upload that
 * answers `STORAGE_NOT_CONFIGURED` opens the dialog then.
 */
export function useStorageGuard(configured?: boolean): StorageGuard {
  const { flags } = useFeatureFlags({ enabled: configured === undefined });
  const [open, setOpen] = useState(false);
  const storageEnabled = configured ?? flags.fileStorageEnabled;
  const showDialog = useCallback(() => {
    setOpen(true);
  }, []);
  const guard = useCallback(
    (openPicker: () => void) => {
      if (storageEnabled) openPicker();
      else setOpen(true);
    },
    [storageEnabled],
  );
  const handleUploadError = useCallback((err: unknown) => {
    if (!isStorageNotConfiguredError(err)) return false;
    setOpen(true);
    return true;
  }, []);
  return {
    storageEnabled,
    guard,
    handleUploadError,
    showDialog,
    dialog: <StorageUnavailableDialog open={open} onOpenChange={setOpen} />,
  };
}
