// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FileUploadButton } from '@/components/ui/file-upload-button';
import { ImportButton } from '@/components/import-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { readCsvText } from '@/lib/csv-parse';
import { getErrorMessage } from '@/lib/error-message';
import { formatFileSize } from '@/lib/formatting';
import { fleetDepartureKeys } from './departure-types';

/** The CSV import limit of the API (512 KB). */
const MAX_CSV_BYTES = 512 * 1024;

export interface DepartureImportResult {
  created: number;
  updated: number;
  unchanged: number;
  refused: Array<{ row: number; field: string; reason: string }>;
}

interface DepartureImportDialogProps {
  fleetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Import departures from a CSV file, then show what was created, updated and refused. */
export function DepartureImportDialog({
  fleetId,
  open,
  onOpenChange,
}: DepartureImportDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<DepartureImportResult | null>(null);

  const mutation = useMutation({
    mutationFn: async (picked: File) => {
      const csv = readCsvText(await picked.text());
      return api.post<DepartureImportResult>(`/v1/fleets/${fleetId}/departures/import`, { csv });
    },
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: fleetDepartureKeys.all(fleetId) });
      void queryClient.invalidateQueries({ queryKey: ['site-charging-plan'] });
    },
  });

  function close(): void {
    setFile(null);
    setFileError(null);
    setResult(null);
    mutation.reset();
    onOpenChange(false);
  }

  function submit(): void {
    if (file == null) {
      setFileError(t('fleets.departures.importChooseFile'));
      return;
    }
    mutation.mutate(file);
  }

  function pick(files: File[]): void {
    const picked = files[0] ?? null;
    mutation.reset();
    setResult(null);
    if (picked != null && picked.size > MAX_CSV_BYTES) {
      setFile(null);
      setFileError(t('fleets.departures.importTooLarge'));
      return;
    }
    setFileError(null);
    setFile(picked);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      dismissible={!mutation.isPending}
    >
      <DialogContent className="max-w-[95vw] md:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('fleets.departures.importTitle')}</DialogTitle>
          <DialogDescription>{t('fleets.departures.importDescription')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="text-sm text-muted-foreground">{t('fleets.departures.importColumns')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <FileUploadButton variant="outline" accept=".csv,text/csv" onFiles={pick}>
              {t('fleets.departures.chooseFile')}
            </FileUploadButton>
            {file != null && (
              <span className="text-sm wrap-anywhere" data-testid="departure-import-file">
                {file.name} ({formatFileSize(file.size)})
              </span>
            )}
          </div>
          {fileError != null && <p className="text-sm text-destructive">{fileError}</p>}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'fleets.departures.importFailed')}
            </p>
          )}

          {result != null && (
            <div className="grid gap-2 text-sm" data-testid="departure-import-result">
              <p>{t('fleets.departures.importCreated', { count: result.created })}</p>
              <p>{t('fleets.departures.importUpdated', { count: result.updated })}</p>
              <p>{t('fleets.departures.importUnchanged', { count: result.unchanged })}</p>
              {result.refused.length > 0 && (
                <>
                  <p className="font-medium">
                    {t('fleets.departures.importRefused', { count: result.refused.length })}
                  </p>
                  <ul className="grid gap-1" data-testid="departure-import-refused">
                    {result.refused.map((r) => (
                      <li key={`${String(r.row)}-${r.field}`} className="text-destructive">
                        {t('fleets.departures.importRefusedRow', {
                          row: r.row,
                          field: r.field,
                          reason: t(`fleets.departures.importReasons.${r.reason}`, {
                            defaultValue: r.reason,
                          }),
                        })}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {result != null ? t('common.close') : t('common.cancel')}
            </Button>
            {result == null && (
              <ImportButton
                label={t('fleets.departures.importCsv')}
                onClick={submit}
                disabled={mutation.isPending}
              />
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
