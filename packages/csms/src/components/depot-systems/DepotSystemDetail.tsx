// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// One bus depot system in Settings > Integrations > Bus Depot Systems: its
// connection state, settings, sign-in (a new password, delete), the requests
// of its last list that were not applied, the identifiers to give the vendor
// and its history.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ConfirmToggle } from '@/components/ui/confirm-toggle';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/content-state';
import { IdText } from '@/components/ui/id-text';
import { Label } from '@/components/ui/label';
import { TabPanel } from '@/components/ui/tab-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { SaveButton } from '@/components/save-button';
import { RemoveButton } from '@/components/remove-button';
import { ExportButton } from '@/components/export-button';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { useTab } from '@/hooks/use-tab';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { formatNumberUpTo } from '@/lib/formatting';
import { buildCsvText, downloadCsv } from '@/lib/csv-download';
import { DepotConnectionBadge } from './DepotConnectionBadge';
import { DepotPasswordDialog } from './DepotPasswordDialog';
import {
  DepotSystemFields,
  depotSystemFormErrors,
  depotSystemFormOf,
  depotTimingsBody,
  type DepotSystemFormValues,
} from './DepotSystemFields';
import {
  DEPOT_SYSTEMS_KEY,
  DEPOT_TIMING_FIELDS,
  depotSystemIdentifiersKey,
  depotSystemKey,
  type DepotSystem,
  type DepotSystemIdentifiers,
  type DepotSystemWithPassword,
} from './depot-system-types';
import { SavedMessage } from '@/components/saved-message';
import { proofBody, useProofStep } from './use-proof-step';

const DETAIL_TABS = ['details', 'refused', 'identifiers', 'history'] as const;

export function DepotSystemDetail({
  id,
  canWrite,
  onBack,
}: {
  id: string;
  canWrite: boolean;
  onBack: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useTab('details', 'depotTab');
  const activeTab = (DETAIL_TABS as readonly string[]).includes(tab) ? tab : 'details';
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: depotSystemKey(id),
    queryFn: () => api.get<DepotSystem>(`/v1/depot-systems/${encodeURIComponent(id)}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-header"
          aria-label={t('nav.back')}
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="min-w-0 text-xl font-semibold wrap-anywhere">
          {data?.name ?? t('depotSystems.title')}
        </h2>
        {data != null && <DepotConnectionBadge system={data} />}
      </div>
      {isLoading ? (
        <LoadingState />
      ) : isError || data == null ? (
        <ErrorState
          onRetry={() => {
            void refetch();
          }}
        />
      ) : (
        <Tabs value={activeTab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="details">{t('depotSystems.tabs.details')}</TabsTrigger>
            <TabsTrigger value="refused">{t('depotSystems.tabs.refused')}</TabsTrigger>
            <TabsTrigger value="identifiers">{t('depotSystems.tabs.identifiers')}</TabsTrigger>
            <TabsTrigger value="history">{t('depotSystems.tabs.history')}</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="mt-4 space-y-6">
            <ConnectionCard system={data} canWrite={canWrite} />
            <SettingsCard key={data.updatedAt} system={data} canWrite={canWrite} />
            {canWrite && <SignInCard system={data} onDeleted={onBack} />}
          </TabsContent>
          <TabsContent value="refused" className="mt-4">
            <RefusedRequests system={data} />
          </TabsContent>
          <TabsContent value="identifiers" className="mt-4">
            <Identifiers system={data} />
          </TabsContent>
          <TabsContent value="history" className="mt-4">
            <EntityHistoryTab entityType="depot_system" entityId={data.id} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function useInvalidate(id: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: DEPOT_SYSTEMS_KEY });
    void queryClient.invalidateQueries({ queryKey: depotSystemKey(id) });
    void queryClient.invalidateQueries({ queryKey: ['audit', 'depot_system'] });
    void queryClient.invalidateQueries({ queryKey: ['fleet-departures'] });
    void queryClient.invalidateQueries({ queryKey: ['site-charging-plan'] });
  };
}

function TimeRow({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">
        {value != null ? formatDateTime(value, timezone) : t('depotSystems.never')}
      </dd>
    </div>
  );
}

function ConnectionCard({
  system,
  canWrite,
}: {
  system: DepotSystem;
  canWrite: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const invalidate = useInvalidate(system.id);
  const proof = useProofStep();
  const [enableOpen, setEnableOpen] = useState(false);
  const toggle = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<DepotSystem>(`/v1/depot-systems/${encodeURIComponent(system.id)}`, body),
    onSuccess: () => {
      setEnableOpen(false);
      invalidate();
    },
    onError: (err: unknown) => {
      proof.failed(err);
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('depotSystems.connection')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label className="leading-6">{t('depotSystems.enabled')}</Label>
            <p className="text-xs text-muted-foreground">{t('depotSystems.enabledHelp')}</p>
          </div>
          <ConfirmToggle
            aria-label={t('depotSystems.enabled')}
            label={t('depotSystems.enabled')}
            offDescription={t('depotSystems.enabledOff')}
            size="lg"
            checked={system.isEnabled}
            disabled={!canWrite || toggle.isPending}
            onCheckedChange={() => {
              if (system.isEnabled) {
                toggle.mutate({ isEnabled: false });
              } else {
                // Turning it on takes the fresh proof.
                toggle.reset();
                proof.reset();
                setEnableOpen(true);
              }
            }}
          />
        </div>
        {system.locked && (
          <p className="text-sm text-destructive">{t('depotSystems.lockedHelp')}</p>
        )}
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <TimeRow label={t('depotSystems.lastConnected')} value={system.lastConnectedAt} />
          <TimeRow label={t('depotSystems.lastBoot')} value={system.lastBootAt} />
          <TimeRow label={t('depotSystems.lastMessage')} value={system.lastMessageAt} />
        </dl>
        <div className="grid gap-2">
          <Label className="leading-6">{t('depotSystems.systemId')}</Label>
          <IdText value={system.presystemId} />
          <p className="text-xs text-muted-foreground">{t('depotSystems.systemIdFixed')}</p>
        </div>
      </CardContent>
      <ConfirmDialog
        open={enableOpen}
        onOpenChange={setEnableOpen}
        title={t('depotSystems.enableTitle')}
        description={t('depotSystems.enableDescription')}
        confirmLabel={t('depotSystems.enableConfirm')}
        variant="default"
        asForm
        isPending={toggle.isPending}
        onConfirm={() => {
          if (!proof.ready()) return false;
          toggle.mutate({ isEnabled: true, ...proofBody(proof) });
          // The dialog stays open until the reply: a refused proof shows in it.
          return false;
        }}
      >
        {proof.field('depot-enable-proof', t('depotSystems.proofHint'))}
      </ConfirmDialog>
    </Card>
  );
}

function SettingsCard({
  system,
  canWrite,
}: {
  system: DepotSystem;
  canWrite: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const invalidate = useInvalidate(system.id);
  const proof = useProofStep();
  const loaded = depotSystemFormOf(system);
  const [values, setValues] = useState<DepotSystemFormValues>(loaded);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const errors = depotSystemFormErrors(values, t, false);
  const sitesChanged = values.siteIds.join(',') !== loaded.siteIds.join(',');
  const timingsChanged = DEPOT_TIMING_FIELDS.some(
    (f) => values.timings[f.key] !== loaded.timings[f.key],
  );
  const dirty =
    values.name !== loaded.name ||
    values.systemType !== loaded.systemType ||
    sitesChanged ||
    timingsChanged;

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<DepotSystem>(`/v1/depot-systems/${encodeURIComponent(system.id)}`, body),
    onSuccess: () => {
      setHasSubmitted(false);
      proof.reset();
      invalidate();
    },
    onError: (err: unknown) => {
      proof.failed(err);
    },
  });

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (!dirty || Object.keys(errors).length > 0) return;
    // A depot change takes the fresh proof.
    if (sitesChanged && !proof.ready()) return;
    const body: Record<string, unknown> = {};
    if (values.name !== loaded.name) body['name'] = values.name.trim();
    if (values.systemType !== loaded.systemType) body['systemType'] = values.systemType;
    if (sitesChanged) Object.assign(body, { siteIds: values.siteIds }, proofBody(proof));
    if (timingsChanged) Object.assign(body, depotTimingsBody(values));
    save.mutate(body);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('depotSystems.settings')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="grid gap-4">
          <DepotSystemFields
            idPrefix="depot-edit"
            values={values}
            onChange={(next) => {
              setValues(next);
              save.reset();
            }}
            errors={hasSubmitted ? errors : {}}
            creating={false}
            disabled={!canWrite}
          />
          {values.systemType !== loaded.systemType && (
            <p className="text-xs text-muted-foreground">{t('depotSystems.closesConnection')}</p>
          )}
          {canWrite &&
            sitesChanged &&
            proof.field('depot-sites-proof', t('depotSystems.proofHint'))}
          {canWrite && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {dirty && (
                <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
              )}
              {save.isSuccess && !dirty && <SavedMessage />}
              <SaveButton isPending={save.isPending} disabled={!dirty || save.isPending} />
            </div>
          )}
          {save.isError && (
            <p className="text-sm text-destructive" role="alert">
              {getErrorMessage(save.error, t)}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function SignInCard({
  system,
  onDeleted,
}: {
  system: DepotSystem;
  onDeleted: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const invalidate = useInvalidate(system.id);
  const proof = useProofStep();
  const [action, setAction] = useState<'password' | 'delete' | null>(null);
  const [credentials, setCredentials] = useState<{ presystemId: string; password: string } | null>(
    null,
  );
  const path = `/v1/depot-systems/${encodeURIComponent(system.id)}`;

  const rotate = useMutation({
    mutationFn: () => api.post<DepotSystemWithPassword>(`${path}/password`, proofBody(proof)),
    onSuccess: (answer) => {
      setAction(null);
      setCredentials({ presystemId: answer.presystemId, password: answer.password });
      invalidate();
    },
    onError: (err: unknown) => {
      proof.failed(err);
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      api.delete<{ id: string; departuresReleased: number }>(path, proofBody(proof)),
    onSuccess: (answer) => {
      setAction(null);
      toast({
        title: t('depotSystems.deleted', { count: answer.departuresReleased }),
        variant: 'success',
      });
      invalidate();
      onDeleted();
    },
    onError: (err: unknown) => {
      proof.failed(err);
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });

  function open(next: 'password' | 'delete'): void {
    rotate.reset();
    remove.reset();
    proof.reset();
    setAction(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('depotSystems.signIn')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('depotSystems.signInHelp')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              open('password');
            }}
          >
            <KeyRound className="h-4 w-4" />
            {t('depotSystems.replacePassword')}
          </Button>
          <RemoveButton
            label={t('depotSystems.delete')}
            onClick={() => {
              open('delete');
            }}
          />
        </div>
      </CardContent>
      <ConfirmDialog
        open={action === 'password'}
        onOpenChange={(o) => {
          if (!o) setAction(null);
        }}
        title={t('depotSystems.replacePassword')}
        description={t('depotSystems.replacePasswordConfirm')}
        confirmLabel={t('depotSystems.replacePassword')}
        variant="default"
        asForm
        isPending={rotate.isPending}
        onConfirm={() => {
          if (proof.ready()) rotate.mutate();
          return false;
        }}
      >
        {proof.field('depot-password-proof', t('depotSystems.proofHint'))}
      </ConfirmDialog>
      <ConfirmDialog
        open={action === 'delete'}
        onOpenChange={(o) => {
          if (!o) setAction(null);
        }}
        title={t('depotSystems.delete')}
        description={t('depotSystems.deleteConfirm')}
        confirmLabel={t('depotSystems.delete')}
        variant="destructive"
        asForm
        isPending={remove.isPending}
        onConfirm={() => {
          if (proof.ready()) remove.mutate();
          return false;
        }}
      >
        {proof.field('depot-delete-proof', t('depotSystems.proofHint'))}
      </ConfirmDialog>
      <DepotPasswordDialog
        credentials={credentials}
        onClose={() => {
          setCredentials(null);
        }}
      />
    </Card>
  );
}

function RefusedRequests({ system }: { system: DepotSystem }): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const rows = system.refusedRequests ?? [];
  return (
    <TabPanel
      title={t('depotSystems.refusedTitle')}
      description={t('depotSystems.refusedDescription')}
      isEmpty={rows.length === 0}
      emptyMessage={t('depotSystems.noRefused')}
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('depotSystems.requestId')}</TableHead>
              <TableHead>{t('depotSystems.vehicle')}</TableHead>
              <TableHead>{t('depotSystems.reason')}</TableHead>
              <TableHead>{t('depotSystems.refusedAt')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.requestId}-${r.reason}`} data-testid="depot-refused-row">
                <TableCell className="font-mono text-xs wrap-anywhere">{r.requestId}</TableCell>
                <TableCell className="font-mono text-xs wrap-anywhere">
                  {r.vehicleRef ?? t('depotSystems.notGiven')}
                </TableCell>
                <TableCell>{t(`depotSystems.refusals.${r.reason}`)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDateTime(r.refusedAt, timezone)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </TabPanel>
  );
}

/** The rows of the identifiers CSV: one row per charging point and one per bus. */
export function identifierCsvRows(ids: DepotSystemIdentifiers): unknown[][] {
  const rows: unknown[][] = [];
  for (const depot of ids.depots) {
    if (depot.stations.length === 0)
      rows.push(['depot', depot.depotId, depot.name, '', '', '', '']);
    for (const station of depot.stations) {
      for (const point of station.chargingPointIds) {
        rows.push([
          'charging_point',
          depot.depotId,
          depot.name,
          station.chargingStationId,
          point,
          '',
          '',
        ]);
      }
    }
  }
  for (const bus of ids.buses ?? []) {
    rows.push(['bus', '', '', '', '', bus.vehicleId, bus.licensePlate ?? '']);
  }
  return rows;
}

export const IDENTIFIER_CSV_HEADERS = [
  'kind',
  'depotId',
  'depotName',
  'chargingStationId',
  'chargingPointId',
  'vehicleId',
  'licensePlate',
] as const;

function Identifiers({ system }: { system: DepotSystem }): React.JSX.Element {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: depotSystemIdentifiersKey(system.id),
    queryFn: () =>
      api.get<DepotSystemIdentifiers>(
        `/v1/depot-systems/${encodeURIComponent(system.id)}/identifiers`,
      ),
  });
  return (
    <div className="space-y-6">
      <TabPanel
        title={t('depotSystems.identifiersTitle')}
        description={t('depotSystems.identifiersDescription')}
        actions={
          data != null ? (
            <ExportButton
              label={t('depotSystems.exportCsv')}
              onClick={() => {
                downloadCsv(
                  `bus-depot-${system.presystemId.replace(/[^A-Za-z0-9_-]/g, '_')}-identifiers.csv`,
                  buildCsvText(IDENTIFIER_CSV_HEADERS, identifierCsvRows(data)),
                );
              }}
            />
          ) : undefined
        }
        isLoading={isLoading}
        isError={isError}
        onRetry={() => {
          void refetch();
        }}
        bodyClassName="space-y-6"
      >
        {data != null && (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('depotSystems.depot')}</TableHead>
                    <TableHead>{t('depotSystems.depotId')}</TableHead>
                    <TableHead>{t('depotSystems.stationId')}</TableHead>
                    <TableHead>{t('depotSystems.chargingPoints')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.depots.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <EmptyState>{t('depotSystems.noDepots')}</EmptyState>
                      </TableCell>
                    </TableRow>
                  )}
                  {data.depots.flatMap((depot) =>
                    depot.stations.length === 0
                      ? [
                          <TableRow key={depot.depotId}>
                            <TableCell className="wrap-anywhere">{depot.name}</TableCell>
                            <TableCell className="font-mono text-xs">{depot.depotId}</TableCell>
                            <TableCell colSpan={2} className="text-muted-foreground">
                              {t('depotSystems.noStations')}
                            </TableCell>
                          </TableRow>,
                        ]
                      : depot.stations.map((station) => (
                          <TableRow key={`${depot.depotId}-${station.chargingStationId}`}>
                            <TableCell className="wrap-anywhere">{depot.name}</TableCell>
                            <TableCell className="font-mono text-xs">{depot.depotId}</TableCell>
                            <TableCell className="font-mono text-xs wrap-anywhere">
                              {station.chargingStationId}
                            </TableCell>
                            <TableCell className="font-mono text-xs wrap-anywhere">
                              {station.chargingPointIds.join(', ')}
                            </TableCell>
                          </TableRow>
                        )),
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">{t('depotSystems.buses')}</h3>
              <p className="text-xs text-muted-foreground">{t('depotSystems.busesHelp')}</p>
              {data.buses == null ? (
                <p className="text-sm text-muted-foreground" data-testid="depot-buses-hidden">
                  {t('depotSystems.busesHidden')}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('depotSystems.vin')}</TableHead>
                        <TableHead>{t('depotSystems.licensePlate')}</TableHead>
                        <TableHead>{t('depotSystems.batteryCapacity')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.buses.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={3}>
                            <EmptyState>{t('depotSystems.noBuses')}</EmptyState>
                          </TableCell>
                        </TableRow>
                      )}
                      {data.buses.map((bus) => (
                        <TableRow key={bus.vehicleId}>
                          <TableCell className="font-mono text-xs">{bus.vehicleId}</TableCell>
                          <TableCell>{bus.licensePlate ?? t('depotSystems.notGiven')}</TableCell>
                          <TableCell>
                            {bus.batteryCapacityKwh != null ? (
                              `${formatNumberUpTo(bus.batteryCapacityKwh, 2)} kWh`
                            ) : (
                              <Badge variant="warning">{t('depotSystems.batteryMissing')}</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </>
        )}
      </TabPanel>
    </div>
  );
}
