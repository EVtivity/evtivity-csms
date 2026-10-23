// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Link2, ShieldCheck, Unlink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { LoadingLogo } from '@/components/loading-logo';
import { DisabledWithReason } from '@/components/sim/DisabledWithReason';
import { simErrorMessage, simKey } from '@/components/sim/sim-connectivity';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api, getApiErrorCode } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { formatDateTime } from '@/lib/timezone';
import { AttachSimDialog } from './AttachSimDialog';
import {
  attachmentSourceKey,
  detachReasonKey,
  type SimAttachmentItem,
  type SimDetailData,
  type SimOpenAttachment,
} from './sim-detail';

interface SimAttachmentsTabProps {
  sim: SimDetailData;
  timezone: string;
}

/** Where the SIM sits now (Confirm, Detach, Attach to Station) and where it sat before. */
export function SimAttachmentsTab({ sim, timezone }: SimAttachmentsTabProps): React.JSX.Element {
  return (
    <div className="space-y-6">
      <CurrentAttachmentCard sim={sim} timezone={timezone} />
      <AttachmentHistoryCard simId={sim.id} timezone={timezone} />
    </div>
  );
}

function SourceText({ source }: { source: string }): React.JSX.Element {
  const { t } = useTranslation();
  const key = attachmentSourceKey(source);
  return <>{key != null ? t(key) : source}</>;
}

function StationText({
  stationId,
  stationOcppId,
}: {
  stationId: string | null;
  stationOcppId: string | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (stationId == null) return <>{t('sims.detail.attachments.paymentTerminal')}</>;
  return (
    <Link to={`/stations/${stationId}`} className="text-link wrap-anywhere hover:underline">
      {stationOcppId ?? stationId}
    </Link>
  );
}

function CurrentAttachmentCard({ sim, timezone }: SimAttachmentsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWriteSims = useHasPermission('sims:write');
  const canWriteStations = useHasPermission('stations:write');
  const allSites = useHasAllSiteAccess();
  // Attach and Confirm reach any station: sims:write, stations:write and all-site access.
  const canAttach = canWriteSims && canWriteStations && allSites;
  const [attachOpen, setAttachOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detachOpen, setDetachOpen] = useState(false);
  const attachment = sim.attachment;
  const station = attachment?.stationOcppId ?? attachment?.stationId ?? '';

  function onChangeError(err: unknown): void {
    toast({ variant: 'destructive', title: simErrorMessage(err, t) });
    // The attachment shown is gone: reload, so the person sees where the SIM is now.
    if (getApiErrorCode(err) === 'SIM_ATTACHMENT_CHANGED') {
      void queryClient.invalidateQueries({ queryKey: simKey(sim.id) });
    }
  }

  const confirm = useMutation({
    mutationFn: (open: SimOpenAttachment) =>
      api.post(`/v1/sims/${sim.id}/attachments/${String(open.id)}/confirm`, {}),
    onSuccess: () => {
      setConfirmOpen(false);
      toast({ variant: 'success', title: t('stations.sim.confirmSuccess') });
      void queryClient.invalidateQueries({ queryKey: ['sims'] });
      // The station Connectivity tab shows the SIM's attachment too.
      void queryClient.invalidateQueries({ queryKey: ['station-sim'] });
    },
    onError: onChangeError,
  });

  const detach = useMutation({
    mutationFn: (open: SimOpenAttachment) =>
      api.post(`/v1/sims/${sim.id}/attachments/${String(open.id)}/detach`, {}),
    onSuccess: () => {
      setDetachOpen(false);
      toast({ variant: 'success', title: t('sims.detail.attachments.detachSuccess') });
      void queryClient.invalidateQueries({ queryKey: ['sims'] });
      // The station Connectivity tab shows the SIM's attachment too.
      void queryClient.invalidateQueries({ queryKey: ['station-sim'] });
    },
    onError: onChangeError,
  });

  const attachButton = (
    <Button
      variant="outline"
      className="gap-1.5"
      disabled={sim.status === 'inactive'}
      onClick={() => {
        setAttachOpen(true);
      }}
    >
      <Link2 className="h-4 w-4" />
      {t('sims.detail.attachments.attach')}
    </Button>
  );

  return (
    <Card data-testid="sim-current-attachment">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('sims.detail.attachments.currentTitle')}</CardTitle>
        <div className="flex flex-wrap gap-2">
          {attachment == null &&
            canAttach &&
            (sim.status === 'inactive' ? (
              <DisabledWithReason reason={t('sims.detail.inactiveReason')}>
                {attachButton}
              </DisabledWithReason>
            ) : (
              attachButton
            ))}
          {attachment != null && !attachment.confirmed && canAttach && (
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setConfirmOpen(true);
              }}
            >
              <ShieldCheck className="h-4 w-4" />
              {t('stations.sim.confirmSim')}
            </Button>
          )}
          {attachment != null && canWriteSims && (
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setDetachOpen(true);
              }}
            >
              <Unlink className="h-4 w-4" />
              {t('sims.detail.attachments.detach')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {attachment == null ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('sims.detail.attachments.notAttached')}
          </p>
        ) : (
          <>
            {!attachment.confirmed && (
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {t('sims.detail.attachments.unconfirmedNotice', { station })}
                </AlertDescription>
              </Alert>
            )}
            <DescriptionList>
              <DescriptionItem label={t('sims.detail.attachments.station')}>
                <StationText
                  stationId={attachment.stationId}
                  stationOcppId={attachment.stationOcppId}
                />
              </DescriptionItem>
              <DescriptionItem label={t('sims.detail.attachments.site')}>
                <span className="wrap-anywhere">{attachment.siteName ?? t('common.na')}</span>
              </DescriptionItem>
              <DescriptionItem label={t('sims.detail.attachments.source')}>
                <SourceText source={attachment.source} />
              </DescriptionItem>
              <DescriptionItem label={t('sims.detail.attachments.attached')}>
                {formatDateTime(attachment.attachedAt, timezone)}
              </DescriptionItem>
              <DescriptionItem label={t('sims.detail.attachments.attachedBy')}>
                {sim.attachedBy?.name ?? t('common.na')}
              </DescriptionItem>
              <DescriptionItem label={t('sims.detail.attachments.confirmed')}>
                {attachment.confirmed ? (
                  <Badge variant="success">
                    {attachment.confirmedAt == null
                      ? t('common.yes')
                      : formatDateTime(attachment.confirmedAt, timezone)}
                  </Badge>
                ) : (
                  <Badge variant="warning">{t('sims.detail.attachments.notConfirmed')}</Badge>
                )}
              </DescriptionItem>
            </DescriptionList>
          </>
        )}
      </CardContent>
      <AttachSimDialog open={attachOpen} onOpenChange={setAttachOpen} simId={sim.id} />
      {attachment != null && (
        <>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            variant="default"
            title={t('stations.sim.confirmSim')}
            description={t('sims.detail.attachments.confirmDescription', {
              iccid: sim.iccid,
              station,
            })}
            confirmLabel={t('stations.sim.confirmSim')}
            isPending={confirm.isPending}
            onConfirm={() => {
              confirm.mutate(attachment);
              return false;
            }}
          />
          <ConfirmDialog
            open={detachOpen}
            onOpenChange={setDetachOpen}
            title={t('sims.detail.attachments.detach')}
            description={t('sims.detail.attachments.detachDescription', {
              iccid: sim.iccid,
              station,
            })}
            confirmLabel={t('sims.detail.attachments.detach')}
            isPending={detach.isPending}
            onConfirm={() => {
              detach.mutate(attachment);
              return false;
            }}
          />
        </>
      )}
    </Card>
  );
}

function AttachmentHistoryCard({
  simId,
  timezone,
}: {
  simId: string;
  timezone: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const history = usePaginatedQuery<SimAttachmentItem>(
    [...simKey(simId), 'attachments'],
    `/v1/sims/${simId}/attachments`,
  );
  const rows = history.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sims.detail.attachments.historyTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {history.isLoading ? (
          <LoadingLogo size="inline" />
        ) : history.isError ? (
          <div className="space-y-2 text-center">
            <p className="text-sm text-destructive">{t('common.loadError')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                history.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('sims.detail.attachments.noHistory')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('sims.detail.attachments.columns.station')}</TableHead>
                    <TableHead>{t('sims.detail.attachments.columns.site')}</TableHead>
                    <TableHead>{t('sims.detail.attachments.columns.source')}</TableHead>
                    <TableHead>{t('sims.detail.attachments.columns.attached')}</TableHead>
                    <TableHead>{t('sims.detail.attachments.columns.detached')}</TableHead>
                    <TableHead>{t('sims.detail.attachments.columns.reason')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const reasonKey =
                      row.detachReason == null ? null : detachReasonKey(row.detachReason);
                    return (
                      <TableRow key={row.id} data-testid={`sim-attachment-row-${String(row.id)}`}>
                        <TableCell>
                          <StationText
                            stationId={row.stationId}
                            stationOcppId={row.stationOcppId}
                          />
                        </TableCell>
                        <TableCell>{row.siteName ?? t('common.na')}</TableCell>
                        <TableCell>
                          <SourceText source={row.source} />
                          {row.attachedBy?.name != null && (
                            <span className="block text-xs text-muted-foreground">
                              {row.attachedBy.name}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {formatDateTime(row.attachedAt, timezone)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {row.detachedAt == null ? (
                            <Badge variant="success">{t('sims.detail.attachments.open')}</Badge>
                          ) : (
                            formatDateTime(row.detachedAt, timezone)
                          )}
                        </TableCell>
                        <TableCell>
                          {row.detachReason == null
                            ? ''
                            : reasonKey != null
                              ? t(reasonKey)
                              : row.detachReason}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <Pagination
              page={history.page}
              totalPages={history.totalPages}
              onPageChange={history.setPage}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
