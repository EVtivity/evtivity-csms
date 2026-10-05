// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';

export interface PncContract {
  id: number;
  emaid: string;
  pcid: string;
  status: 'active' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
}

export interface DriverPncContractsCardProps {
  driverId: string;
  timezone: string;
}

const PCID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * ISO 15118 contracts of a driver for the local contract CA: each one is an
 * eMAID bound to the PCID of the vehicle that may install it. Shown when
 * Plug & Charge is enabled or the driver has contracts.
 */
export function DriverPncContractsCard({
  driverId,
  timezone,
}: DriverPncContractsCardProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('drivers:write');
  const canReadSettings = useHasPermission('settings.system:read');
  const [createOpen, setCreateOpen] = useState(false);
  const [pcid, setPcid] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<PncContract | null>(null);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/settings'),
    enabled: canReadSettings,
    staleTime: 60_000,
  });
  const { data: contracts } = useQuery({
    queryKey: ['drivers', driverId, 'pnc-contracts'],
    queryFn: () => api.get<PncContract[]>(`/v1/drivers/${driverId}/pnc-contracts`),
    staleTime: 30_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['drivers', driverId, 'pnc-contracts'] });
    void queryClient.invalidateQueries({ queryKey: ['drivers', driverId, 'tokens'] });
  };

  const createMutation = useMutation({
    mutationFn: (value: string) =>
      api.post<PncContract>(`/v1/drivers/${driverId}/pnc-contracts`, { pcid: value }),
    onSuccess: (contract) => {
      toast({
        title: t('drivers.pncContractCreated', { emaid: contract.emaid }),
        variant: 'success',
      });
      invalidate();
      setCreateOpen(false);
      setPcid('');
    },
    onError: (err) => {
      toast({
        title: t('drivers.pncContractCreateFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: number) =>
      api.post<PncContract>(`/v1/drivers/${driverId}/pnc-contracts/${String(id)}/revoke`, {}),
    onSuccess: () => {
      toast({ title: t('drivers.pncContractRevoked'), variant: 'success' });
      invalidate();
      setRevokeTarget(null);
    },
    onError: (err) => {
      toast({
        title: t('drivers.pncContractRevokeFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
      setRevokeTarget(null);
    },
  });

  const pncEnabled = settings?.['pnc.enabled'] === true;
  const list = contracts ?? [];
  if (!pncEnabled && list.length === 0) return null;

  const pcidValid = PCID_PATTERN.test(pcid);

  return (
    <Card data-testid="driver-pnc-contracts">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('drivers.pncContracts')}</CardTitle>
        {canWrite && (
          <Button
            variant="outline"
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t('drivers.pncContractCreate')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">{t('drivers.pncContractsHelp')}</p>
        {list.length === 0 ? (
          <p className="text-muted-foreground">{t('drivers.pncContractsEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('drivers.pncEmaid')}</TableHead>
                  <TableHead>{t('drivers.pncPcid')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('common.created')}</TableHead>
                  {canWrite && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((contract) => (
                  <TableRow key={contract.id}>
                    <TableCell className="font-mono">{contract.emaid}</TableCell>
                    <TableCell className="font-mono">{contract.pcid}</TableCell>
                    <TableCell>
                      <Badge variant={contract.status === 'active' ? 'success' : 'destructive'}>
                        {t(`drivers.pncContractStatus.${contract.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatDateTime(contract.createdAt, timezone)}</TableCell>
                    {canWrite && (
                      <TableCell className="text-right">
                        {contract.status === 'active' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setRevokeTarget(contract);
                            }}
                          >
                            {t('drivers.pncContractRevoke')}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t('drivers.pncContractCreate')}
        description={t('drivers.pncContractCreateConfirm')}
        confirmLabel={t('drivers.pncContractCreate')}
        variant="default"
        isPending={createMutation.isPending}
        onConfirm={() => {
          if (pcidValid) createMutation.mutate(pcid);
          return false;
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="pnc-contract-pcid">{t('drivers.pncPcid')}</Label>
          <Input
            id="pnc-contract-pcid"
            value={pcid}
            maxLength={64}
            onChange={(e) => {
              setPcid(e.target.value);
            }}
            placeholder="WMIV1234567890ABC"
          />
          <p className="text-xs text-muted-foreground">{t('drivers.pncPcidHelp')}</p>
          {pcid !== '' && !pcidValid && (
            <p className="text-xs text-destructive">{t('drivers.pncPcidInvalid')}</p>
          )}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={revokeTarget != null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={t('drivers.pncContractRevoke')}
        description={t('drivers.pncContractRevokeConfirm', { emaid: revokeTarget?.emaid ?? '' })}
        confirmLabel={t('drivers.pncContractRevoke')}
        isPending={revokeMutation.isPending}
        onConfirm={() => {
          if (revokeTarget != null) revokeMutation.mutate(revokeTarget.id);
          return false;
        }}
      />
    </Card>
  );
}
