// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CancelButton } from '@/components/cancel-button';
import { StationCombobox, type StationSelection } from '@/components/station-combobox';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { simErrorMessage } from '@/components/sim/sim-connectivity';
import { api } from '@/lib/api';
import type { SimAttachmentItem } from './sim-detail';

interface AttachSimDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  simId: string;
}

/**
 * Attach to Station: pick a station and attach the SIM, confirmed at once
 * (`POST /v1/sims/:id/attachments`). A station that has a SIM and a SIM
 * attached elsewhere are refused; the dialog shows why.
 */
export function AttachSimDialog(props: AttachSimDialogProps): React.JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && <AttachSimForm {...props} />}
    </Dialog>
  );
}

function AttachSimForm({ onOpenChange, simId }: AttachSimDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [station, setStation] = useState<StationSelection | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const attach = useMutation({
    mutationFn: (stationId: string) =>
      api.post<SimAttachmentItem>(`/v1/sims/${simId}/attachments`, { stationId }),
    onSuccess: (attachment) => {
      toast({
        variant: 'success',
        title: t('sims.detail.attachments.attachSuccess', {
          station: attachment.stationOcppId ?? station?.stationId ?? '',
        }),
      });
      void queryClient.invalidateQueries({ queryKey: ['sims'] });
      // The station Connectivity tab shows the SIM's attachment too.
      void queryClient.invalidateQueries({ queryKey: ['station-sim'] });
      onOpenChange(false);
    },
  });

  const stationError = station == null ? t('validation.selectRequired') : null;

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (station == null) return;
    attach.mutate(station.id);
  }

  return (
    <DialogContent className="max-w-[95vw] md:max-w-lg">
      <form onSubmit={handleSubmit} noValidate className="min-w-0 space-y-4">
        <DialogHeader>
          <DialogTitle>{t('sims.detail.attachments.attachTitle')}</DialogTitle>
          <DialogDescription>{t('sims.detail.attachments.attachDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="sim-attach-station">{t('sims.detail.attachments.station')}</Label>
          <StationCombobox
            id="sim-attach-station"
            invalid={hasSubmitted && stationError != null}
            value={station}
            onSelect={(next) => {
              setStation(next);
              attach.reset();
            }}
          />
          {hasSubmitted && stationError != null && (
            <p className="text-sm text-destructive">{stationError}</p>
          )}
        </div>
        {attach.isError && (
          <p className="text-sm text-destructive">{simErrorMessage(attach.error, t)}</p>
        )}
        <DialogFooter>
          <CancelButton
            onClick={() => {
              onOpenChange(false);
            }}
          />
          <Button type="submit" className="relative" disabled={attach.isPending}>
            {attach.isPending && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              </div>
            )}
            <span className={attach.isPending ? 'invisible' : ''}>
              {t('sims.detail.attachments.attach')}
            </span>
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
