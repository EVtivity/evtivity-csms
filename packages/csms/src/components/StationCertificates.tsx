// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, ShieldPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState } from '@/components/ui/content-state';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { stationCertificateStatusVariant } from '@/lib/status-variants';
import { useCanSendOcppCommand } from '@/lib/ocpp-command-access';

interface StationCertificate {
  id: number;
  stationId: string;
  certificateType: string;
  serialNumber: string | null;
  issuer: string | null;
  subject: string | null;
  validFrom: string | null;
  validTo: string | null;
  status: string;
  source: string | null;
  createdAt: string;
}

interface StationCertificatesProps {
  stationId: string;
}

export function StationCertificates({ stationId }: StationCertificatesProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const queryClient = useQueryClient();
  // Station certificate commands need certificates:write.
  const canSend = useCanSendOcppCommand();
  const canManage = canSend('InstallCertificate');

  const [installOpen, setInstallOpen] = useState(false);
  const [installCertType, setInstallCertType] = useState('V2GRootCertificate');
  const [installPem, setInstallPem] = useState('');

  const {
    data: certs,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['stations', stationId, 'certificates'],
    queryFn: () =>
      api.get<{ data: StationCertificate[]; total: number }>(
        `/v1/stations/${stationId}/certificates?limit=50`,
      ),
  });

  const installMutation = useMutation({
    mutationFn: (body: { certificateType: string; certificate: string }) =>
      api.post(`/v1/stations/${stationId}/certificates/install`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', stationId, 'certificates'] });
      setInstallOpen(false);
      setInstallPem('');
    },
  });

  const queryInstalledMutation = useMutation({
    mutationFn: () => api.post(`/v1/stations/${stationId}/certificates/query`, {}),
  });

  const certificates = certs?.data ?? [];

  return (
    <>
      <TabPanel
        title={t('pnc.certificates')}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => {
          void refetch();
        }}
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2 *:grow sm:*:grow-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  queryInstalledMutation.mutate();
                }}
                disabled={queryInstalledMutation.isPending}
              >
                <RefreshCw
                  className={`h-4 w-4 ${queryInstalledMutation.isPending ? 'animate-spin' : ''}`}
                />
                {t('stations.refreshConfigurations')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setInstallOpen(true);
                }}
              >
                <ShieldPlus className="h-4 w-4" />
                {t('pnc.installCertificate')}
              </Button>
            </div>
          ) : undefined
        }
      >
        {queryInstalledMutation.isSuccess && (
          <p className="text-sm text-success">{t('pnc.commandSent')}</p>
        )}

        {certificates.length === 0 ? (
          <EmptyState>{t('pnc.noStationCertificates')}</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('pnc.certificateType')}</TableHead>
                <TableHead>{t('pnc.subject')}</TableHead>
                <TableHead>{t('pnc.validTo')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('pnc.source')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {certificates.map((cert) => (
                <TableRow key={cert.id}>
                  <TableCell>{cert.certificateType}</TableCell>
                  <TableCell className="max-w-48 truncate">{cert.subject}</TableCell>
                  <TableCell>
                    {cert.validTo != null ? formatDateTime(cert.validTo, timezone) : '-'}
                  </TableCell>
                  <TableCell>
                    {
                      <Badge variant={stationCertificateStatusVariant(cert.status)}>
                        {cert.status}
                      </Badge>
                    }
                  </TableCell>
                  <TableCell>{cert.source ?? '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabPanel>

      <Dialog open={installOpen} onOpenChange={setInstallOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pnc.installCertificate')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="install-cert-type" className="leading-6">
                {t('pnc.certificateType')}
              </Label>
              <Select
                id="install-cert-type"
                value={installCertType}
                onChange={(e) => {
                  setInstallCertType(e.target.value);
                }}
              >
                <option value="V2GRootCertificate">V2G Root Certificate</option>
                <option value="MORootCertificate">MO Root Certificate</option>
                <option value="CSMSRootCertificate">CSMS Root Certificate</option>
                <option value="ManufacturerRootCertificate">Manufacturer Root Certificate</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="install-pem" className="leading-6">
                PEM
              </Label>
              <textarea
                id="install-pem"
                className="h-48 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
                value={installPem}
                onChange={(e) => {
                  setInstallPem(e.target.value);
                }}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                installMutation.mutate({
                  certificateType: installCertType,
                  certificate: installPem,
                });
              }}
              disabled={installMutation.isPending || installPem.trim() === ''}
            >
              {t('pnc.installCertificate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
