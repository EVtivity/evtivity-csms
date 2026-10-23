// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { CancelButton } from '@/components/cancel-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { getErrorMessage } from '@/lib/error-message';

interface CsvImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dialog title, such as "Import Sites". */
  title: string;
  rowCount: number;
  filename: string;
  updateExisting: boolean;
  onUpdateExistingChange: (updateExisting: boolean) => void;
  isPending: boolean;
  /** The error of a failed import, null when none. */
  error: unknown;
  onConfirm: () => void;
}

/**
 * The confirmation of a CSV import, shared by the list pages that import a
 * CSV (Sites, SIMs): the row count and file name, the Update Existing choice,
 * the error of a failed import, Cancel and Import CSV.
 */
export function CsvImportDialog({
  open,
  onOpenChange,
  title,
  rowCount,
  filename,
  updateExisting,
  onUpdateExistingChange,
  isPending,
  error,
  onConfirm,
}: CsvImportDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const updateExistingId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] md:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm">
            {t('sites.importConfirmMessage', {
              count: rowCount,
              filename,
            })}
          </p>
          <div className="flex items-center gap-2">
            <Checkbox
              id={updateExistingId}
              checked={updateExisting}
              onChange={(e) => {
                onUpdateExistingChange(e.target.checked);
              }}
            />
            <Label htmlFor={updateExistingId}>{t('sites.updateExisting')}</Label>
          </div>
          <p className="text-xs text-muted-foreground">{t('sites.updateExistingDescription')}</p>
          {error != null && <p className="text-sm text-destructive">{getErrorMessage(error, t)}</p>}
        </div>
        <DialogFooter>
          <CancelButton
            onClick={() => {
              onOpenChange(false);
            }}
          />
          <Button onClick={onConfirm} disabled={isPending}>
            {isPending ? t('sites.importing') : t('sites.importCsv')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CsvImportResultCardProps {
  /** One line per count the import changed, already translated. */
  lines: string[];
  /** The `Row N: <reason>` problems the import reported. */
  errors: string[];
}

/** The result of a CSV import above the list: the counts and the rows it skipped. */
export function CsvImportResultCard({
  lines,
  errors,
}: CsvImportResultCardProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="p-3 text-sm space-y-1">
        <p className="font-medium">{t('sites.importResults')}</p>
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {errors.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-destructive">
              {t('sites.importErrors')} ({errors.length})
            </summary>
            <ul className="mt-1 list-disc pl-4 text-destructive">
              {errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
