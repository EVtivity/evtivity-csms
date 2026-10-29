// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Power, PowerOff, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TabPanel } from '@/components/ui/tab-panel';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { IdText } from '@/components/ui/id-text';
import { useToast } from '@/components/ui/toast';
import { DisabledWithReason } from '@/components/sim/DisabledWithReason';
import { SimProviderStatusCard } from '@/components/sim/SimProviderStatusCard';
import { SimRefreshCard } from '@/components/sim/SimRefreshCard';
import {
  providerName,
  resetSuccessKey,
  simErrorMessage,
  simKey,
} from '@/components/sim/sim-connectivity';
import type { SimRefreshController } from '@/components/sim/use-sim-refresh';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { formatDateTime } from '@/lib/timezone';
import { SimEditForm } from './SimEditForm';
import type { SimDetailData } from './sim-detail';

interface SimDetailsTabProps {
  sim: SimDetailData;
  controller: SimRefreshController;
  timezone: string;
}

/**
 * The SIM, its CSMS status (Deactivate, Reactivate, Delete), the Refresh of
 * its provider data, the provider status and the label, notes and IMSI form.
 */
export function SimDetailsTab({
  sim,
  controller,
  timezone,
}: SimDetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const canWrite = useHasPermission('sims:write');
  const inactiveReason = sim.status === 'inactive' ? t('sims.detail.inactiveReason') : null;

  return (
    <div className="space-y-6">
      <SimInfoCard sim={sim} timezone={timezone} />
      <SimRefreshCard
        controller={controller}
        title={t('sims.detail.refreshTitle')}
        hint={t('sims.detail.refreshHint')}
        disabledReason={inactiveReason}
      />
      <SimProviderCard sim={sim} controller={controller} timezone={timezone} />
      {canWrite && <SimEditForm sim={sim} />}
    </div>
  );
}

function SimInfoCard({
  sim,
  timezone,
}: {
  sim: SimDetailData;
  timezone: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Deactivate, Reactivate and Delete reach SIMs of every site: all-site access.
  const canWrite = useHasPermission('sims:write');
  const allSites = useHasAllSiteAccess();
  const canManage = canWrite && allSites;
  const [statusOpen, setStatusOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const active = sim.status === 'active';
  const na = t('common.na');

  const setStatus = useMutation({
    mutationFn: () => api.post(`/v1/sims/${sim.id}/${active ? 'deactivate' : 'reactivate'}`, {}),
    onSuccess: () => {
      setStatusOpen(false);
      toast({
        variant: 'success',
        title: active ? t('sims.detail.deactivateSuccess') : t('sims.detail.reactivateSuccess'),
      });
      // The SIM, its attachments and the list (the status and the attachment change).
      void queryClient.invalidateQueries({ queryKey: ['sims'] });
      // The station Connectivity tab shows the SIM's attachment too.
      void queryClient.invalidateQueries({ queryKey: ['station-sim'] });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: simErrorMessage(err, t) });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/v1/sims/${sim.id}`),
    onSuccess: () => {
      setDeleteOpen(false);
      toast({ variant: 'success', title: t('sims.detail.deleteSuccess') });
      queryClient.removeQueries({ queryKey: simKey(sim.id) });
      void queryClient.invalidateQueries({ queryKey: ['sims'] });
      // The station Connectivity tab shows the SIM's attachment too.
      void queryClient.invalidateQueries({ queryKey: ['station-sim'] });
      void navigate('/sims');
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: simErrorMessage(err, t) });
    },
  });

  const statusLabel = active ? t('sims.detail.deactivate') : t('sims.detail.reactivate');
  const deleteButton = (
    <Button
      variant="destructive"
      className="gap-1.5"
      disabled={sim.attachment != null}
      onClick={() => {
        setDeleteOpen(true);
      }}
    >
      <Trash2 className="h-4 w-4" />
      {t('sims.detail.delete')}
    </Button>
  );

  return (
    <TabPanel
      title={t('sims.detail.tabs.details')}
      actions={
        canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={active ? 'outline' : 'default'}
              className="gap-1.5"
              onClick={() => {
                setStatusOpen(true);
              }}
            >
              {active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
              {statusLabel}
            </Button>
            {sim.attachment != null ? (
              <DisabledWithReason
                reason={t('sims.detail.deleteAttachedReason')}
                testId="sim-delete-disabled"
              >
                {deleteButton}
              </DisabledWithReason>
            ) : (
              deleteButton
            )}
          </div>
        ) : undefined
      }
    >
      <DescriptionList>
        <DescriptionItem label={t('sims.detail.iccid')}>
          <IdText value={sim.iccid} />
        </DescriptionItem>
        <DescriptionItem label={t('sims.detail.imsi')}>
          {sim.imsi == null ? na : <IdText value={sim.imsi} />}
        </DescriptionItem>
        <DescriptionItem label={t('sims.detail.label')}>
          <span className="wrap-anywhere">{sim.label ?? na}</span>
        </DescriptionItem>
        <DescriptionItem label={t('sims.detail.notes')}>
          <span className="whitespace-pre-wrap wrap-anywhere">{sim.notes ?? na}</span>
        </DescriptionItem>
        <DescriptionItem label={t('sims.detail.csmsStatus')}>
          <span className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant={active ? 'success' : 'secondary'}>
                {t(`sims.csmsStatus.${sim.status}`)}
              </Badge>
              {!active && sim.deactivatedAt != null && (
                <span className="text-xs text-muted-foreground">
                  {sim.deactivatedByUser?.name != null
                    ? t('sims.detail.deactivatedBy', {
                        time: formatDateTime(sim.deactivatedAt, timezone),
                        name: sim.deactivatedByUser.name,
                      })
                    : t('sims.detail.deactivatedAt', {
                        time: formatDateTime(sim.deactivatedAt, timezone),
                      })}
                </span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">{t('sims.detail.csmsStatusHint')}</span>
          </span>
        </DescriptionItem>
        <DescriptionItem label={t('sims.detail.provider')}>
          {sim.provider == null ? na : providerName(sim.provider)}
        </DescriptionItem>
        <DescriptionItem label={t('sims.detail.providerRef')}>
          {sim.providerRef == null ? na : <IdText value={sim.providerRef} />}
        </DescriptionItem>
        <DescriptionItem label={t('sims.detail.created')}>
          {formatDateTime(sim.createdAt, timezone)}
        </DescriptionItem>
      </DescriptionList>
      <ConfirmDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        variant={active ? 'destructive' : 'default'}
        title={statusLabel}
        description={
          active ? t('sims.detail.deactivateDescription') : t('sims.detail.reactivateDescription')
        }
        confirmLabel={statusLabel}
        isPending={setStatus.isPending}
        onConfirm={() => {
          setStatus.mutate();
          return false;
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('sims.detail.delete')}
        description={t('sims.detail.deleteDescription', { iccid: sim.iccid })}
        confirmLabel={t('sims.detail.delete')}
        isPending={remove.isPending}
        onConfirm={() => {
          remove.mutate();
          return false;
        }}
      />
    </TabPanel>
  );
}

function SimProviderCard({ sim, controller, timezone }: SimDetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('sims:write');
  const [resetOpen, setResetOpen] = useState(false);
  const inactive = sim.status === 'inactive';

  const reset = useMutation({
    mutationFn: () => api.post(`/v1/sims/${sim.id}/network-reset`, {}),
    onSuccess: (reply) => {
      setResetOpen(false);
      toast({ variant: 'success', title: t(resetSuccessKey(reply)) });
      void queryClient.invalidateQueries({ queryKey: simKey(sim.id) });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: simErrorMessage(err, t) });
    },
  });

  if (sim.provider == null) {
    const notFound = sim.lookupMissReason === 'not_found';
    return (
      <TabPanel title={t('stations.sim.fromProviderTitle')}>
        <div className="space-y-3 text-center" data-testid="sim-no-provider">
          <p className="text-sm text-muted-foreground">
            {notFound ? t('sims.detail.providerNotFound') : t('sims.detail.noProvider')}
          </p>
          {notFound && !inactive && (
            <Button
              variant="outline"
              disabled={controller.refresh.isPending}
              onClick={() => {
                controller.refreshWithDays(true);
              }}
            >
              {t('stations.sim.lookUpAgain')}
            </Button>
          )}
        </div>
      </TabPanel>
    );
  }

  const canReset = canWrite && sim.capabilities?.networkReset === true;
  const resetButton = (
    <Button
      variant="outline"
      className="gap-1.5"
      disabled={inactive}
      onClick={() => {
        setResetOpen(true);
      }}
    >
      <RotateCcw className="h-4 w-4" />
      {t('stations.sim.resetNetwork')}
    </Button>
  );

  return (
    <SimProviderStatusCard
      provider={sim.provider}
      capabilities={sim.capabilities}
      status={sim.lastStatus}
      statusFetchedAt={sim.statusFetchedAt}
      network={sim.network}
      recentAlerts={sim.recentAlerts}
      showRecentAlerts
      timezone={timezone}
      stateLabel={t('sims.detail.providerStatus')}
      noRecentAlertsLabel={t('sims.detail.noRecentAlerts')}
      actions={
        canReset ? (
          inactive ? (
            <DisabledWithReason
              reason={t('sims.detail.inactiveReason')}
              testId="sim-reset-disabled"
            >
              {resetButton}
            </DisabledWithReason>
          ) : (
            resetButton
          )
        ) : null
      }
    >
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t('stations.sim.resetNetwork')}
        description={t('sims.detail.resetDescription')}
        confirmLabel={t('stations.sim.resetNetwork')}
        isPending={reset.isPending}
        onConfirm={() => {
          reset.mutate();
          return false;
        }}
      />
    </SimProviderStatusCard>
  );
}
