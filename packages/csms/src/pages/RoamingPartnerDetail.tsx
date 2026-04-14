// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CopyableId } from '@/components/copyable-id';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getErrorMessage } from '@/lib/error-message';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { Pagination } from '@/components/ui/pagination';
import { useState } from 'react';
import { roamingPartnerStatusVariant } from '@/lib/status-variants';

interface PartnerEndpoint {
  id: number;
  module: string;
  interfaceRole: string;
  url: string;
}

interface PartnerDetail {
  id: string;
  name: string;
  countryCode: string;
  partyId: string;
  status: string;
  version: string | null;
  versionUrl: string | null;
  roles: unknown[];
  ourRoles: unknown[];
  createdAt: string;
  updatedAt: string;
  endpoints: PartnerEndpoint[];
}

interface SyncLogEntry {
  id: number;
  partnerId: string;
  module: string;
  direction: string;
  action: string;
  status: string;
  objectsCount: string;
  errorMessage: string | null;
  createdAt: string;
}

export function RoamingPartnerDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const queryClient = useQueryClient();
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const { data: partner, isLoading } = useQuery({
    queryKey: ['ocpi-partners', id],
    queryFn: () => api.get<PartnerDetail>(`/v1/ocpi/partners/${id ?? ''}`),
    enabled: id != null,
  });

  const {
    data: syncLog,
    page: syncPage,
    totalPages: syncTotalPages,
    setPage: setSyncPage,
  } = usePaginatedQuery<SyncLogEntry>('ocpi-sync-log', '/v1/ocpi/sync-log', {
    partnerId: id ?? '',
  });

  const registerMutation = useMutation({
    mutationFn: () => api.post(`/v1/ocpi/partners/${id ?? ''}/register`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocpi-partners', id] });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.delete(`/v1/ocpi/partners/${id ?? ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocpi-partners'] });
      void navigate('/roaming/partners');
    },
  });

  if (isLoading || partner == null) {
    return <div className="p-6">{t('common.loading')}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{partner.name}</h1>
          <CopyableId id={partner.id} />
          <p className="text-muted-foreground">
            {partner.countryCode}-{partner.partyId}
          </p>
        </div>
        <div className="flex gap-2">
          {partner.status === 'pending' && (
            <Button
              onClick={() => {
                registerMutation.mutate();
              }}
              disabled={registerMutation.isPending}
            >
              {registerMutation.isPending
                ? t('roaming.partners.registering')
                : t('roaming.partners.register')}
            </Button>
          )}
          {partner.status !== 'disconnected' && (
            <Button
              variant="destructive"
              onClick={() => {
                setDisconnectOpen(true);
              }}
            >
              {t('roaming.partners.disconnect')}
            </Button>
          )}
        </div>
      </div>

      {registerMutation.isError && (
        <p className="text-sm text-destructive">{getErrorMessage(registerMutation.error, t)}</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t('common.status')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={roamingPartnerStatusVariant(partner.status)}>{partner.status}</Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t('roaming.partners.version')}</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-lg font-semibold">{partner.version ?? '-'}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              {t('roaming.partners.versionsUrl')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm break-all">{partner.versionUrl ?? '-'}</span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('roaming.partners.endpoints')}</CardTitle>
        </CardHeader>
        <CardContent>
          {partner.endpoints.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('roaming.partners.noEndpoints')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('roaming.partners.module')}</TableHead>
                  <TableHead>{t('roaming.partners.role')}</TableHead>
                  <TableHead>{t('roaming.partners.url')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {partner.endpoints.map((ep) => (
                  <TableRow key={ep.id}>
                    <TableCell className="font-medium">{ep.module}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{ep.interfaceRole}</Badge>
                    </TableCell>
                    <TableCell className="text-sm break-all">{ep.url}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('roaming.partners.syncHistory')}</CardTitle>
        </CardHeader>
        <CardContent>
          {syncLog == null || syncLog.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('roaming.partners.noSyncLog')}</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('roaming.partners.module')}</TableHead>
                    <TableHead>{t('roaming.partners.direction')}</TableHead>
                    <TableHead>{t('roaming.partners.action')}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead>{t('roaming.partners.objects')}</TableHead>
                    <TableHead>{t('common.created')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {syncLog.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>{entry.module}</TableCell>
                      <TableCell>{entry.direction}</TableCell>
                      <TableCell>{entry.action}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            entry.status === 'completed'
                              ? 'default'
                              : entry.status === 'failed'
                                ? 'destructive'
                                : 'secondary'
                          }
                        >
                          {entry.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{entry.objectsCount}</TableCell>
                      <TableCell>{formatDateTime(entry.createdAt, timezone)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {syncTotalPages > 1 && (
                <Pagination
                  page={syncPage}
                  totalPages={syncTotalPages}
                  onPageChange={setSyncPage}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={t('roaming.partners.disconnectTitle')}
        description={t('roaming.partners.disconnectDescription')}
        confirmLabel={t('roaming.partners.disconnect')}
        variant="destructive"
        onConfirm={() => {
          disconnectMutation.mutate();
        }}
        isPending={disconnectMutation.isPending}
      />
    </div>
  );
}
