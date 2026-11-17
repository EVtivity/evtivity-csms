// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  FLEET_CARD_IMPORT_MAX_BYTES,
  FLEET_CARD_IMPORT_TEMPLATE,
  FLEET_USER_CARD_IMPORT_TEMPLATE,
} from '@evtivity/lib/fleet-card-import';
import { Button } from '@/components/ui/button';
import { FileUploadButton } from '@/components/ui/file-upload-button';
import { ImportButton } from '@/components/import-button';
import { TemplateButton } from '@/components/template-button';
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
import { useIsFleetUser } from '@/lib/auth';

export interface FleetCardImportResult {
  created: number;
  refused: Array<{ row: number; field: string; reason: string }>;
}

interface FleetCardImportDialogProps {
  fleetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Saves the CSV template of the fleet card import. A fleet user's template has
 * no member email column: the import matches member emails for operators only.
 */
export function downloadFleetCardTemplate(fleetUser = false): void {
  const template = fleetUser ? FLEET_USER_CARD_IMPORT_TEMPLATE : FLEET_CARD_IMPORT_TEMPLATE;
  const blob = new Blob([template], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'fleet-rfid-cards-template.csv';
  link.click();
  URL.revokeObjectURL(url);
}

/** Import fleet RFID cards from a CSV file, then show what was added and refused. */
export function FleetCardImportDialog({
  fleetId,
  open,
  onOpenChange,
}: FleetCardImportDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const fleetUser = useIsFleetUser();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<FleetCardImportResult | null>(null);

  const mutation = useMutation({
    mutationFn: async (picked: File) => {
      const csv = readCsvText(await picked.text());
      return api.post<FleetCardImportResult>(`/v1/fleets/${fleetId}/cards/import`, { csv });
    },
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'cards'] });
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
      setFileError(t('fleets.cards.import.chooseFirst'));
      return;
    }
    mutation.mutate(file);
  }

  function pick(files: File[]): void {
    const picked = files[0] ?? null;
    mutation.reset();
    setResult(null);
    if (picked != null && picked.size > FLEET_CARD_IMPORT_MAX_BYTES) {
      setFile(null);
      setFileError(t('fleets.cards.import.tooLarge'));
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
          <DialogTitle>{t('fleets.cards.import.title')}</DialogTitle>
          <DialogDescription>{t('fleets.cards.import.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="text-sm text-muted-foreground">
            {t(fleetUser ? 'fleets.cards.import.columnsFleetUser' : 'fleets.cards.import.columns')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <TemplateButton
              label={t('fleets.cards.import.template')}
              onClick={() => {
                downloadFleetCardTemplate(fleetUser);
              }}
            />
            <FileUploadButton variant="outline" accept=".csv,text/csv" onFiles={pick}>
              {t('fleets.cards.import.chooseFile')}
            </FileUploadButton>
            {file != null && (
              <span className="text-sm wrap-anywhere" data-testid="fleet-card-import-file">
                {file.name} ({formatFileSize(file.size)})
              </span>
            )}
          </div>
          {fileError != null && <p className="text-sm text-destructive">{fileError}</p>}
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'fleets.cards.import.failed')}
            </p>
          )}

          {result != null && (
            <div className="grid gap-2 text-sm" data-testid="fleet-card-import-result">
              <p>{t('fleets.cards.import.created', { count: result.created })}</p>
              {result.refused.length > 0 && (
                <>
                  <p className="font-medium">
                    {t('fleets.cards.import.refused', { count: result.refused.length })}
                  </p>
                  <ul className="grid gap-1" data-testid="fleet-card-import-refused">
                    {result.refused.map((r) => (
                      <li key={`${String(r.row)}-${r.field}`} className="text-destructive">
                        {t('fleets.cards.import.refusedRow', {
                          row: r.row,
                          field: r.field,
                          reason: t(`fleets.cards.import.reasons.${r.reason}`, {
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
                label={t('fleets.cards.import.submit')}
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
