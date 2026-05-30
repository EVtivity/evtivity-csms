// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, RefreshCw, Trash2, Loader2, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { FilterPopover } from '@/components/FilterBar';
import { certificateStatusVariant } from '@/lib/status-variants';

interface CaCertificate {
  id: number;
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

function isExpiringSoon(validTo: string | null): boolean {
  if (validTo == null) return false;
  const diff = new Date(validTo).getTime() - Date.now();
  return diff > 0 && diff < 30 * 24 * 60 * 60 * 1000;
}

export function CaCertificatesTab(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const queryClient = useQueryClient();

  const [caStatusFilter, setCaStatusFilter] = useState('');

  // Upload CA cert dialog
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadCertType, setUploadCertType] = useState('V2GRootCertificate');
  const [uploadPem, setUploadPem] = useState('');

  const caParams = caStatusFilter ? { status: caStatusFilter } : undefined;

  const {
    data: caCerts,
    page: caPage,
    totalPages: caTotalPages,
    setPage: setCaPage,
  } = usePaginatedQuery<CaCertificate>('pnc-ca-certificates', '/v1/pnc/ca-certificates', caParams);

  const uploadMutation = useMutation({
    mutationFn: (body: { certificate: string; certificateType: string }) =>
      api.post('/v1/pnc/ca-certificates', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pnc-ca-certificates'] });
      setUploadOpen(false);
      setUploadPem('');
    },
  });

  const deleteCaMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/v1/pnc/ca-certificates/${String(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pnc-ca-certificates'] });
    },
  });

  const refreshRootsMutation = useMutation({
    mutationFn: () => api.post('/v1/pnc/refresh-root-certificates', {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pnc-ca-certificates'] });
    },
  });

  return (
    <>
      <TabsContent value="ca">
        <Card>
          <CardHeader>
            <div className="flex flex-row items-center justify-between gap-2">
              <CardTitle>{t('pnc.caCertificates')}</CardTitle>
              <div className="flex flex-col gap-2 [&>*]:w-full sm:flex-row sm:items-center sm:[&>*]:w-auto">
                <Button
                  variant="outline"
                  onClick={() => {
                    refreshRootsMutation.mutate();
                  }}
                  disabled={refreshRootsMutation.isPending}
                >
                  {refreshRootsMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {t('pnc.refreshRootCerts')}
                </Button>
                <Button
                  onClick={() => {
                    setUploadOpen(true);
                  }}
                >
                  <Upload className="h-4 w-4" />
                  {t('pnc.uploadCaCert')}
                </Button>
                <Select
                  aria-label={t('common.status')}
                  value={caStatusFilter}
                  onChange={(e) => {
                    setCaStatusFilter(e.target.value);
                  }}
                  className="hidden h-9 w-auto md:block"
                >
                  <option value="">{t('common.all')}</option>
                  <option value="active">{t('pnc.active')}</option>
                  <option value="expired">{t('pnc.expired')}</option>
                  <option value="revoked">{t('pnc.revoked')}</option>
                </Select>
                <FilterPopover
                  className="md:hidden"
                  activeCount={caStatusFilter ? 1 : 0}
                  onClearAll={() => {
                    setCaStatusFilter('');
                  }}
                >
                  <div className="space-y-2">
                    <Label>{t('common.status')}</Label>
                    <Select
                      aria-label={t('common.status')}
                      value={caStatusFilter}
                      onChange={(e) => {
                        setCaStatusFilter(e.target.value);
                      }}
                      className="h-10"
                    >
                      <option value="">{t('common.all')}</option>
                      <option value="active">{t('pnc.active')}</option>
                      <option value="expired">{t('pnc.expired')}</option>
                      <option value="revoked">{t('pnc.revoked')}</option>
                    </Select>
                  </div>
                </FilterPopover>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="info">
              <Info className="h-4 w-4" />
              <AlertDescription>{t('pnc.caCertificatesHelp')}</AlertDescription>
            </Alert>
            {caCerts == null || caCerts.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('pnc.noCaCertificates')}
              </p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('pnc.certificateType')}</TableHead>
                      <TableHead>{t('pnc.subject')}</TableHead>
                      <TableHead>{t('pnc.issuer')}</TableHead>
                      <TableHead>{t('pnc.validTo')}</TableHead>
                      <TableHead>{t('common.status')}</TableHead>
                      <TableHead>{t('pnc.source')}</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {caCerts.map((cert) => (
                      <TableRow key={cert.id}>
                        <TableCell>{cert.certificateType}</TableCell>
                        <TableCell className="max-w-48 truncate">{cert.subject}</TableCell>
                        <TableCell className="max-w-48 truncate">{cert.issuer}</TableCell>
                        <TableCell>
                          {cert.validTo != null ? formatDateTime(cert.validTo, timezone) : '-'}
                          {isExpiringSoon(cert.validTo) && (
                            <Badge variant="secondary" className="ml-1">
                              {t('pnc.expiring')}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {
                            <Badge variant={certificateStatusVariant(cert.status)}>
                              {cert.status}
                            </Badge>
                          }
                        </TableCell>
                        <TableCell>{cert.source ?? '-'}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('common.delete')}
                            onClick={() => {
                              deleteCaMutation.mutate(cert.id);
                            }}
                            disabled={deleteCaMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pagination page={caPage} totalPages={caTotalPages} onPageChange={setCaPage} />
              </>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* Upload CA Certificate Dialog */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pnc.uploadCaCert')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="upload-cert-type">{t('pnc.certificateType')}</Label>
              <Select
                id="upload-cert-type"
                value={uploadCertType}
                onChange={(e) => {
                  setUploadCertType(e.target.value);
                }}
                className="h-9"
              >
                <option value="V2GRootCertificate">V2G Root Certificate</option>
                <option value="MORootCertificate">MO Root Certificate</option>
                <option value="CSMSRootCertificate">CSMS Root Certificate</option>
                <option value="ManufacturerRootCertificate">Manufacturer Root Certificate</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="upload-pem">PEM</Label>
              <textarea
                id="upload-pem"
                className="h-48 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
                value={uploadPem}
                onChange={(e) => {
                  setUploadPem(e.target.value);
                }}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                uploadMutation.mutate({
                  certificate: uploadPem,
                  certificateType: uploadCertType,
                });
              }}
              disabled={uploadMutation.isPending || uploadPem.trim() === ''}
            >
              {t('pnc.uploadCaCert')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
