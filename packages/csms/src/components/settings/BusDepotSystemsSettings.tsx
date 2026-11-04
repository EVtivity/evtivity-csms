// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Settings > Integrations > Bus Depot Systems: the bus depot interface switch
// (`vdv463.enabled`), the WebSocket address for the vendor and the bus depot
// systems (VDV 463 depot management systems and ITCS). All-site users only;
// a system opens in place (`?depotSystem=<id>`).

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmToggle } from '@/components/ui/confirm-toggle';
import { EmptyState, TableStateRow } from '@/components/ui/content-state';
import { IdText } from '@/components/ui/id-text';
import { Label } from '@/components/ui/label';
import { TabPanel } from '@/components/ui/tab-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { CreateButton } from '@/components/create-button';
import { DepotConnectionBadge } from '@/components/depot-systems/DepotConnectionBadge';
import { DepotPasswordDialog } from '@/components/depot-systems/DepotPasswordDialog';
import { DepotSystemCreateDialog } from '@/components/depot-systems/DepotSystemCreateDialog';
import { DepotSystemDetail } from '@/components/depot-systems/DepotSystemDetail';
import { useDepotSiteOptions } from '@/components/depot-systems/DepotSystemFields';
import {
  DEPOT_SYSTEMS_KEY,
  depotWebSocketUrl,
  type DepotSystemList,
} from '@/components/depot-systems/depot-system-types';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { API_BASE_URL } from '@/lib/config';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

export const DEPOT_SYSTEM_PARAMS = ['depotSystem', 'depotTab'] as const;

export function BusDepotSystemsSettings({
  settings,
}: {
  settings: Record<string, unknown> | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const allSites = useHasAllSiteAccess();
  const canWrite = useHasPermission('settings.integrations:write');
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('depotSystem');

  function select(id: string | null): void {
    setSearchParams(
      () => {
        const next = new URLSearchParams(window.location.search);
        for (const p of DEPOT_SYSTEM_PARAMS) next.delete(p);
        if (id != null) next.set('depotSystem', id);
        return next;
      },
      { replace: id == null },
    );
  }

  if (!allSites) {
    return (
      <Alert variant="info">
        <Info />
        <AlertDescription>{t('depotSystems.allSitesOnly')}</AlertDescription>
      </Alert>
    );
  }
  if (selected != null && selected !== '') {
    return (
      <DepotSystemDetail
        id={selected}
        canWrite={canWrite}
        onBack={() => {
          select(null);
        }}
      />
    );
  }
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t('depotSystems.description')}</p>
      <InterfaceCard settings={settings} canWrite={canWrite} />
      <SystemList canWrite={canWrite} onSelect={select} />
    </div>
  );
}

function InterfaceCard({
  settings,
  canWrite,
}: {
  settings: Record<string, unknown> | undefined;
  canWrite: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [state, setState] = useLoadedValues({ enabled: settings?.['vdv463.enabled'] === true });
  const { data } = useQuery({
    queryKey: DEPOT_SYSTEMS_KEY,
    queryFn: () => api.get<DepotSystemList>('/v1/depot-systems'),
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => api.put('/v1/settings/vdv463.enabled', { value: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: unknown, enabled: boolean) => {
      setState({ enabled: !enabled });
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });
  const connection = data?.connection;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('depotSystems.interfaceTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label className="leading-6">{t('depotSystems.interfaceEnabled')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('depotSystems.interfaceEnabledHelp')}
            </p>
          </div>
          <ConfirmToggle
            aria-label={t('depotSystems.interfaceEnabled')}
            label={t('depotSystems.interfaceEnabled')}
            offDescription={t('depotSystems.interfaceEnabledOff')}
            size="lg"
            checked={state.enabled}
            disabled={!canWrite || mutation.isPending}
            onCheckedChange={() => {
              setState({ enabled: !state.enabled });
              mutation.mutate(!state.enabled);
            }}
          />
        </div>
        {connection != null && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="grid min-w-0 gap-2">
              <Label className="leading-6">{t('depotSystems.webSocketUrl')}</Label>
              <IdText value={depotWebSocketUrl(API_BASE_URL, connection.path)} />
              <p className="text-xs text-muted-foreground">{t('depotSystems.webSocketUrlHelp')}</p>
            </div>
            <div className="grid min-w-0 gap-2">
              <Label className="leading-6">{t('depotSystems.subprotocol')}</Label>
              <IdText value={connection.subprotocol} />
              <p className="text-xs text-muted-foreground">{t('depotSystems.subprotocolHelp')}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SystemList({
  canWrite,
  onSelect,
}: {
  canWrite: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const [createOpen, setCreateOpen] = useState(false);
  const [credentials, setCredentials] = useState<{
    id: string;
    presystemId: string;
    password: string;
  } | null>(null);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: DEPOT_SYSTEMS_KEY,
    queryFn: () => api.get<DepotSystemList>('/v1/depot-systems'),
  });
  const { sites } = useDepotSiteOptions();
  const siteName = (id: string): string => sites.find((s) => s.id === id)?.name ?? id;
  const rows = data?.data ?? [];

  return (
    <>
      <TabPanel
        title={t('depotSystems.title')}
        description={t('depotSystems.listDescription')}
        actions={
          canWrite ? (
            <CreateButton
              label={t('depotSystems.create')}
              onClick={() => {
                setCreateOpen(true);
              }}
            />
          ) : undefined
        }
        isLoading={isLoading}
        isError={isError}
        onRetry={() => {
          void refetch();
        }}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('depotSystems.name')}</TableHead>
                <TableHead>{t('depotSystems.systemId')}</TableHead>
                <TableHead>{t('depotSystems.type')}</TableHead>
                <TableHead>{t('depotSystems.depots')}</TableHead>
                <TableHead>{t('depotSystems.status')}</TableHead>
                <TableHead>{t('depotSystems.lastConnected')}</TableHead>
                <TableHead>{t('depotSystems.lastMessage')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableStateRow colSpan={7}>
                  <EmptyState>{t('depotSystems.empty')}</EmptyState>
                </TableStateRow>
              )}
              {rows.map((s) => (
                <TableRow
                  key={s.id}
                  className="cursor-pointer"
                  data-testid={`depot-system-row-${s.id}`}
                  onClick={() => {
                    onSelect(s.id);
                  }}
                >
                  <TableCell className="font-medium text-link wrap-anywhere">{s.name}</TableCell>
                  <TableCell className="font-mono text-xs wrap-anywhere">{s.presystemId}</TableCell>
                  <TableCell>{t(`depotSystems.types.${s.systemType}`)}</TableCell>
                  <TableCell className="wrap-anywhere">
                    {s.siteIds.map(siteName).join(', ')}
                  </TableCell>
                  <TableCell>
                    <DepotConnectionBadge system={s} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {s.lastConnectedAt != null
                      ? formatDateTime(s.lastConnectedAt, timezone)
                      : t('depotSystems.never')}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {s.lastMessageAt != null
                      ? formatDateTime(s.lastMessageAt, timezone)
                      : t('depotSystems.never')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </TabPanel>
      {canWrite && (
        <DepotSystemCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(created) => {
            setCreateOpen(false);
            setCredentials({
              id: created.id,
              presystemId: created.presystemId,
              password: created.password,
            });
          }}
        />
      )}
      <DepotPasswordDialog
        credentials={credentials}
        onClose={() => {
          const id = credentials?.id;
          setCredentials(null);
          if (id != null) onSelect(id);
        }}
      />
    </>
  );
}
