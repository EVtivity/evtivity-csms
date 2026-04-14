// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { ResponsiveFilters } from '@/components/responsive-filters';
import { certificateStatusVariant } from '@/lib/status-variants';

interface CsrRequest {
  id: number;
  stationId: string | null;
  certificateType: string;
  status: string;
  providerReference: string | null;
  errorMessage: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export function CsrRequestsTab(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const queryClient = useQueryClient();

  const [csrStatusFilter, setCsrStatusFilter] = useState('');

  // Sign CSR dialog
  const [signOpen, setSignOpen] = useState(false);
  const [signCsrId, setSignCsrId] = useState<number | null>(null);
  const [signedChain, setSignedChain] = useState('');

  const csrParams = csrStatusFilter ? { status: csrStatusFilter } : undefined;

  const {
    data: csrRequests,
    page: csrPage,
    totalPages: csrTotalPages,
    setPage: setCsrPage,
  } = usePaginatedQuery<CsrRequest>('pnc-csr-requests', '/v1/pnc/csr-requests', csrParams);

  const signCsrMutation = useMutation({
    mutationFn: (body: { id: number | null; signedCertificateChain: string }) =>
      api.post(`/v1/pnc/csr-requests/${String(body.id)}/sign`, {
        signedCertificateChain: body.signedCertificateChain,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pnc-csr-requests'] });
      setSignOpen(false);
      setSignedChain('');
    },
  });

  const rejectCsrMutation = useMutation({
    mutationFn: (id: number) => api.post(`/v1/pnc/csr-requests/${String(id)}/reject`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pnc-csr-requests'] });
    },
  });

  return (
    <>
      <TabsContent value="csr">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t('pnc.csrRequests')}</CardTitle>
              <ResponsiveFilters activeCount={csrStatusFilter ? 1 : 0}>
                <Select
                  aria-label="Filter by status"
                  value={csrStatusFilter}
                  onChange={(e) => {
                    setCsrStatusFilter(e.target.value);
                  }}
                  className="h-9 w-32"
                >
                  <option value="">{t('common.all')}</option>
                  <option value="pending">{t('pnc.pending')}</option>
                  <option value="submitted">{t('pnc.submitted')}</option>
                  <option value="signed">{t('pnc.signed')}</option>
                  <option value="rejected">{t('pnc.rejected')}</option>
                  <option value="expired">{t('pnc.expired')}</option>
                </Select>
              </ResponsiveFilters>
            </div>
          </CardHeader>
          <CardContent>
            {csrRequests == null || csrRequests.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('pnc.noCsrRequests')}
              </p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('pnc.certificateType')}</TableHead>
                      <TableHead>{t('common.status')}</TableHead>
                      <TableHead>{t('common.created')}</TableHead>
                      <TableHead>{t('pnc.source')}</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {csrRequests.map((csr) => (
                      <TableRow key={csr.id}>
                        <TableCell>{csr.certificateType}</TableCell>
                        <TableCell>
                          {
                            <Badge variant={certificateStatusVariant(csr.status)}>
                              {csr.status}
                            </Badge>
                          }
                        </TableCell>
                        <TableCell>{formatDateTime(csr.createdAt, timezone)}</TableCell>
                        <TableCell>{csr.providerReference ?? '-'}</TableCell>
                        <TableCell>
                          {csr.status === 'pending' && (
                            <div className="flex gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setSignCsrId(csr.id);
                                  setSignOpen(true);
                                }}
                              >
                                {t('pnc.sign')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  rejectCsrMutation.mutate(csr.id);
                                }}
                                disabled={rejectCsrMutation.isPending}
                              >
                                {t('pnc.reject')}
                              </Button>
                            </div>
                          )}
                          {csr.errorMessage != null && (
                            <span className="text-xs text-destructive">{csr.errorMessage}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pagination page={csrPage} totalPages={csrTotalPages} onPageChange={setCsrPage} />
              </>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* Sign CSR Dialog */}
      <Dialog open={signOpen} onOpenChange={setSignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pnc.signCsr')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('pnc.signCsrDescription')}</p>
            <div className="space-y-2">
              <Label htmlFor="signed-chain">{t('pnc.signedCertificateChain')}</Label>
              <textarea
                id="signed-chain"
                className="h-48 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
                value={signedChain}
                onChange={(e) => {
                  setSignedChain(e.target.value);
                }}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                signCsrMutation.mutate({
                  id: signCsrId,
                  signedCertificateChain: signedChain,
                });
              }}
              disabled={signCsrMutation.isPending || signedChain.trim() === ''}
            >
              {t('pnc.sign')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
