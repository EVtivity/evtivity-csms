// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EditButton } from '@/components/edit-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents } from '@/lib/formatting';
import { centsToMajorInput, parseMajorInputToCents } from '@evtivity/lib/currency';

/** GET and PATCH /v1/fleets/:id/credit-limit. */
export interface FleetCreditLimit {
  creditLimitCents: number | null;
  warningPercent: number;
  exposure: {
    unbilledCents: number;
    invoicedCents: number;
    runningCents: number;
    totalCents: number;
    currency: string;
  };
  level: 'ok' | 'warning' | 'reached' | null;
}

export interface FleetCreditLimitCardProps {
  fleetId: string;
}

const LEVEL_VARIANT = { ok: 'success', warning: 'warning', reached: 'destructive' } as const;
const LEVEL_LABEL = {
  ok: 'fleets.creditLimit.levelOk',
  warning: 'fleets.creditLimit.levelWarning',
  reached: 'fleets.creditLimit.levelReached',
} as const;

/** The fleet's credit limit (account starts refused at the limit) and its exposure. */
export function FleetCreditLimitCard({ fleetId }: FleetCreditLimitCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('fleets:write');
  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState('');
  const [percent, setPercent] = useState('');
  const [errors, setErrors] = useState<{ limit?: string; percent?: string }>({});

  const queryKey = ['fleets', fleetId, 'credit-limit'];
  const { data, isError } = useQuery({
    queryKey,
    queryFn: () => api.get<FleetCreditLimit>(`/v1/fleets/${fleetId}/credit-limit`),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (body: { creditLimitCents: number | null; warningPercent: number }) =>
      api.patch<FleetCreditLimit>(`/v1/fleets/${fleetId}/credit-limit`, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKey, updated);
      toast({ title: t('fleets.creditLimit.updated'), variant: 'success' });
      setEditing(false);
    },
    onError: (err) => {
      toast({
        title: t('fleets.creditLimit.updateFailed'),
        description: getErrorMessage(err, t),
        variant: 'destructive',
      });
    },
  });

  function startEdit(): void {
    if (data == null) return;
    setLimit(data.creditLimitCents != null ? centsToMajorInput(data.creditLimitCents) : '');
    setPercent(String(data.warningPercent));
    setErrors({});
    setEditing(true);
  }

  function save(e: React.SyntheticEvent): void {
    e.preventDefault();
    const next: { limit?: string; percent?: string } = {};
    // DecimalInput accepts "10,5" and "10.5" in any language and reports the
    // canonical "10.5"; parsed from the text, so no float rounding.
    const trimmed = limit.trim();
    const limitCents = trimmed === '' ? null : parseMajorInputToCents(trimmed);
    if (trimmed !== '' && (limitCents == null || limitCents <= 0)) {
      next.limit = t('fleets.creditLimit.invalidLimit');
    }
    const warningPercent = Number(percent);
    if (!Number.isInteger(warningPercent) || warningPercent < 1 || warningPercent > 99) {
      next.percent = t('fleets.creditLimit.invalidPercent');
    }
    setErrors(next);
    if (next.limit != null || next.percent != null) return;
    mutation.mutate({ creditLimitCents: limitCents, warningPercent });
  }

  const currency = data?.exposure.currency ?? '';

  return (
    <Card data-testid="fleet-credit-limit">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t('fleets.creditLimit.title')}</CardTitle>
          <CardDescription>{t('fleets.creditLimit.description')}</CardDescription>
        </div>
        {canWrite && !editing && data != null && (
          <EditButton label={t('common.edit')} onClick={startEdit} />
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {isError && <p className="text-destructive">{t('fleets.creditLimit.loadFailed')}</p>}
        {data != null && editing && (
          <form onSubmit={save} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="fleet-credit-limit">
                  {t('fleets.creditLimit.limit')}
                  {currency !== '' ? ` (${currency})` : ''}
                </Label>
                <DecimalInput
                  id="fleet-credit-limit"
                  value={limit}
                  onChange={setLimit}
                  decimalScale={2}
                  className={errors.limit != null ? 'border-destructive' : ''}
                />
                {errors.limit != null ? (
                  <p className="text-destructive">{errors.limit}</p>
                ) : (
                  <p className="text-muted-foreground">{t('fleets.creditLimit.limitHelp')}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="fleet-credit-warning">
                  {t('fleets.creditLimit.warningPercent')}
                </Label>
                <Input
                  id="fleet-credit-warning"
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  value={percent}
                  onChange={(e) => {
                    setPercent(e.target.value);
                  }}
                  className={errors.percent != null ? 'border-destructive' : ''}
                />
                {errors.percent != null ? (
                  <p className="text-destructive">{errors.percent}</p>
                ) : (
                  <p className="text-muted-foreground">{t('fleets.creditLimit.warningHelp')}</p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  setEditing(false);
                }}
              />
              <SaveButton isPending={mutation.isPending} />
            </div>
          </form>
        )}
        {data != null && !editing && (
          <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t('fleets.creditLimit.limit')}</dt>
              <dd className="flex items-center gap-2 font-medium">
                {data.creditLimitCents != null
                  ? formatCents(data.creditLimitCents, currency)
                  : t('fleets.creditLimit.noLimit')}
                {data.level != null && (
                  <Badge variant={LEVEL_VARIANT[data.level]}>{t(LEVEL_LABEL[data.level])}</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fleets.creditLimit.warningPercent')}</dt>
              <dd className="font-medium">{data.warningPercent}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fleets.creditLimit.exposure')}</dt>
              <dd className="font-medium">{formatCents(data.exposure.totalCents, currency)}</dd>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t('fleets.creditLimit.unbilled')}</span>
                <span>{formatCents(data.exposure.unbilledCents, currency)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t('fleets.creditLimit.invoiced')}</span>
                <span>{formatCents(data.exposure.invoicedCents, currency)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t('fleets.creditLimit.running')}</span>
                <span>{formatCents(data.exposure.runningCents, currency)}</span>
              </div>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
