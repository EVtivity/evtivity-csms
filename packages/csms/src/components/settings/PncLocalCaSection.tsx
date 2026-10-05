// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

export interface LocalCaStatus {
  configured: boolean;
  createdAt: string | null;
  certificates: Array<{
    schema: 2 | 20;
    role: 'moRoot' | 'moSubCa1' | 'moSubCa2' | 'cpsRoot' | 'cpsSubCa1' | 'cpsSubCa2' | 'cpsLeaf';
    subject: string;
    serialNumber: string;
    validFrom: string;
    validTo: string;
  }>;
}

export interface PncLocalCaSectionProps {
  emaidCountry: string;
  emaidProviderId: string;
  onEmaidCountryChange: (value: string) => void;
  onEmaidProviderIdChange: (value: string) => void;
}

/**
 * Settings > Plug & Charge for the local provider: the eMAID prefix of the
 * contracts it issues and the contract CA (created once, keys never shown).
 */
export function PncLocalCaSection({
  emaidCountry,
  emaidProviderId,
  onEmaidCountryChange,
  onEmaidProviderIdChange,
}: PncLocalCaSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const timezone = useUserTimezone();
  const canWrite = useHasPermission('settings.integrations:write');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data: ca } = useQuery({
    queryKey: ['pnc-local-ca'],
    queryFn: () => api.get<LocalCaStatus>('/v1/pnc/settings/local-ca'),
    staleTime: 60_000,
  });

  const createMutation = useMutation({
    mutationFn: () => api.post<LocalCaStatus>('/v1/pnc/settings/local-ca', {}),
    onSuccess: (status) => {
      queryClient.setQueryData(['pnc-local-ca'], status);
      toast({ title: t('settings.pncLocalCaCreated'), variant: 'success' });
      setConfirmOpen(false);
    },
    onError: (err) => {
      toast({
        title: t('settings.pncLocalCaCreateFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
      setConfirmOpen(false);
    },
  });

  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="pnc-local-ca">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('settings.pncLocalCa')}</p>
        <p className="text-xs text-muted-foreground">{t('settings.pncLocalCaDescription')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="pnc-emaid-country" className="leading-6">
            {t('settings.pncEmaidCountry')}
          </Label>
          <Input
            id="pnc-emaid-country"
            value={emaidCountry}
            maxLength={2}
            onChange={(e) => {
              onEmaidCountryChange(e.target.value.toUpperCase());
            }}
            placeholder="US"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pnc-emaid-provider" className="leading-6">
            {t('settings.pncEmaidProviderId')}
          </Label>
          <Input
            id="pnc-emaid-provider"
            value={emaidProviderId}
            maxLength={3}
            onChange={(e) => {
              onEmaidProviderIdChange(e.target.value.toUpperCase());
            }}
            placeholder="EVT"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.pncEmaidHint')}</p>

      <div className="flex flex-wrap items-center gap-3">
        {ca != null && (
          <Badge variant={ca.configured ? 'success' : 'outline'}>
            {ca.configured
              ? t('settings.pncLocalCaConfigured')
              : t('settings.pncLocalCaNotConfigured')}
          </Badge>
        )}
        {ca?.createdAt != null && (
          <span className="text-xs text-muted-foreground">
            {t('settings.pncLocalCaCreatedAt', { date: formatDateTime(ca.createdAt, timezone) })}
          </span>
        )}
        {canWrite && ca != null && !ca.configured && (
          <Button
            variant="outline"
            onClick={() => {
              setConfirmOpen(true);
            }}
          >
            <ShieldPlus className="h-4 w-4" />
            {t('settings.pncLocalCaCreate')}
          </Button>
        )}
      </div>

      {ca?.configured === true && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('settings.pncLocalCaEdition')}</TableHead>
                <TableHead>{t('settings.pncLocalCaRole')}</TableHead>
                <TableHead>{t('pnc.subject')}</TableHead>
                <TableHead>{t('pnc.validTo')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ca.certificates.map((cert) => (
                <TableRow key={`${String(cert.schema)}-${cert.role}`}>
                  <TableCell>ISO 15118-{String(cert.schema)}</TableCell>
                  <TableCell>{t(`settings.pncLocalCaRoles.${cert.role}`)}</TableCell>
                  <TableCell className="font-mono text-xs">{cert.subject}</TableCell>
                  <TableCell>{formatDateTime(cert.validTo, timezone)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('settings.pncLocalCaCreate')}
        description={t('settings.pncLocalCaCreateConfirm')}
        confirmLabel={t('settings.pncLocalCaCreate')}
        variant="default"
        isPending={createMutation.isPending}
        onConfirm={() => {
          createMutation.mutate();
          return false;
        }}
      />
    </div>
  );
}
