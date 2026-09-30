// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { formatRatePerKwh } from '@/lib/formatting';
import { SaveButton } from '@/components/save-button';
import { CancelButton } from '@/components/cancel-button';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

interface RateRestrictions {
  timeRange?: { startTime: string; endTime: string };
  daysOfWeek?: number[];
  dateRange?: { startDate: string; endDate: string };
}

interface ElectricityRate {
  id: number;
  siteId: string;
  name: string;
  ratePerKwh: number;
  restrictions: RateRestrictions | null;
  priority: number;
  isDefault: boolean;
}

type RestrictionType = 'always' | 'time' | 'timeDays' | 'date';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface FormState {
  name: string;
  ratePerKwh: string;
  type: RestrictionType;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
  startDate: string;
  endDate: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  ratePerKwh: '',
  type: 'always',
  startTime: '09:00',
  endTime: '17:00',
  daysOfWeek: [1, 2, 3, 4, 5],
  startDate: '06-01',
  endDate: '09-30',
};

function restrictionTypeOf(r: RateRestrictions | null): RestrictionType {
  if (r == null) return 'always';
  if (r.dateRange != null) return 'date';
  if (r.daysOfWeek != null && r.timeRange != null) return 'timeDays';
  if (r.timeRange != null) return 'time';
  return 'always';
}

function buildRestrictions(form: FormState): RateRestrictions | null {
  switch (form.type) {
    case 'time':
      return { timeRange: { startTime: form.startTime, endTime: form.endTime } };
    case 'timeDays':
      return {
        timeRange: { startTime: form.startTime, endTime: form.endTime },
        daysOfWeek: form.daysOfWeek,
      };
    case 'date':
      return { dateRange: { startDate: form.startDate, endDate: form.endDate } };
    default:
      return null;
  }
}

export function SiteElectricityRatesTab({ siteId }: { siteId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ElectricityRate | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<ElectricityRate | null>(null);

  const queryKey = ['site-electricity-rates', siteId];
  const { currency } = useCompanyCurrency();

  const { data: rates = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => api.get<ElectricityRate[]>(`/v1/sites/${siteId}/electricity-rates`),
  });

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey });
  }

  function describeRestrictions(r: RateRestrictions | null): string {
    if (r == null) return t('sites.electricityRateAlways');
    const parts: string[] = [];
    if (r.daysOfWeek != null) {
      parts.push(r.daysOfWeek.map((d) => DAY_LABELS[d]).join(', '));
    }
    if (r.timeRange != null) {
      parts.push(`${r.timeRange.startTime}–${r.timeRange.endTime}`);
    }
    if (r.dateRange != null) {
      parts.push(`${r.dateRange.startDate} – ${r.dateRange.endDate}`);
    }
    return parts.join(' · ');
  }

  const saveMutation = useMutation({
    mutationFn: (payload: {
      name: string;
      ratePerKwh: number;
      restrictions: RateRestrictions | null;
    }) =>
      editing == null
        ? api.post<ElectricityRate>(`/v1/sites/${siteId}/electricity-rates`, payload)
        : api.patch<ElectricityRate>(
            `/v1/sites/${siteId}/electricity-rates/${String(editing.id)}`,
            payload,
          ),
    onSuccess: () => {
      toast({
        title:
          editing == null ? t('sites.electricityRateCreated') : t('sites.electricityRateUpdated'),
        variant: 'success',
      });
      setDialogOpen(false);
      invalidate();
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.message : t('common.error');
      toast({ title: message, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      api.delete<{ success: boolean }>(`/v1/sites/${siteId}/electricity-rates/${String(id)}`),
    onSuccess: () => {
      toast({ title: t('sites.electricityRateDeleted'), variant: 'success' });
      setDeleteTarget(null);
      invalidate();
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.message : t('common.error');
      toast({ title: message, variant: 'destructive' });
    },
  });

  function openCreate(): void {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(rate: ElectricityRate): void {
    setEditing(rate);
    const type = restrictionTypeOf(rate.restrictions);
    setForm({
      name: rate.name,
      ratePerKwh: String(rate.ratePerKwh),
      type,
      startTime: rate.restrictions?.timeRange?.startTime ?? '09:00',
      endTime: rate.restrictions?.timeRange?.endTime ?? '17:00',
      daysOfWeek: rate.restrictions?.daysOfWeek ?? [1, 2, 3, 4, 5],
      startDate: rate.restrictions?.dateRange?.startDate ?? '06-01',
      endDate: rate.restrictions?.dateRange?.endDate ?? '09-30',
    });
    setDialogOpen(true);
  }

  function toggleDay(day: number): void {
    setForm((f) => ({
      ...f,
      daysOfWeek: f.daysOfWeek.includes(day)
        ? f.daysOfWeek.filter((d) => d !== day)
        : [...f.daysOfWeek, day].sort((a, b) => a - b),
    }));
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    saveMutation.mutate({
      name: form.name,
      ratePerKwh: Number(form.ratePerKwh),
      restrictions: buildRestrictions(form),
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('sites.electricityRates')}</CardTitle>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          {t('sites.addElectricityRate')}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? null : rates.length === 0 ? (
          <div className="py-8">
            <p className="text-center text-sm font-medium">{t('sites.noElectricityRates')}</p>
            <p className="text-center text-sm text-muted-foreground">
              {t('sites.noElectricityRatesDescription')}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('sites.electricityRateName')}</TableHead>
                <TableHead className="text-right">{t('sites.ratePerKwh')}</TableHead>
                <TableHead>{t('sites.electricityRateRestrictions')}</TableHead>
                <TableHead className="text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.map((rate) => (
                <TableRow key={rate.id}>
                  <TableCell>{rate.name}</TableCell>
                  <TableCell className="text-right">
                    {currency != null ? formatRatePerKwh(rate.ratePerKwh, currency) : '-'}
                  </TableCell>
                  <TableCell>{describeRestrictions(rate.restrictions)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('common.edit')}
                      onClick={() => {
                        openEdit(rate);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('sites.deleteElectricityRate')}
                      onClick={() => {
                        setDeleteTarget(rate);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing == null ? t('sites.addElectricityRate') : t('sites.electricityRate')}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} noValidate className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="rate-name">{t('sites.electricityRateName')}</Label>
              <Input
                id="rate-name"
                value={form.name}
                onChange={(e) => {
                  setForm((f) => ({ ...f, name: e.target.value }));
                }}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rate-value">{t('sites.ratePerKwh')}</Label>
              <DecimalInput
                id="rate-value"
                value={form.ratePerKwh}
                onChange={(value) => {
                  setForm((f) => ({ ...f, ratePerKwh: value }));
                }}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rate-type">{t('sites.electricityRateRestrictions')}</Label>
              <Select
                id="rate-type"
                value={form.type}
                onChange={(e) => {
                  setForm((f) => ({ ...f, type: e.target.value as RestrictionType }));
                }}
              >
                <option value="always">{t('sites.electricityRateAlways')}</option>
                <option value="time">{t('sites.electricityRateTimeOfDay')}</option>
                <option value="timeDays">{t('sites.electricityRateDayAndTime')}</option>
                <option value="date">{t('sites.electricityRateSeasonal')}</option>
              </Select>
            </div>

            {(form.type === 'time' || form.type === 'timeDays') && (
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="rate-start-time">{t('pricing.startTime')}</Label>
                  <Input
                    id="rate-start-time"
                    type="time"
                    value={form.startTime}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, startTime: e.target.value }));
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="rate-end-time">{t('pricing.endTime')}</Label>
                  <Input
                    id="rate-end-time"
                    type="time"
                    value={form.endTime}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, endTime: e.target.value }));
                    }}
                  />
                </div>
              </div>
            )}

            {form.type === 'timeDays' && (
              <div className="grid gap-2">
                <Label>{t('sites.electricityRateDaysOfWeek')}</Label>
                <div className="flex flex-wrap gap-2">
                  {DAY_LABELS.map((label, day) => (
                    <Button
                      key={label}
                      type="button"
                      variant={form.daysOfWeek.includes(day) ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        toggleDay(day);
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {form.type === 'date' && (
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="rate-start-date">{t('pricing.startDate')}</Label>
                  <Input
                    id="rate-start-date"
                    placeholder="MM-DD"
                    value={form.startDate}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, startDate: e.target.value }));
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="rate-end-date">{t('pricing.endDate')}</Label>
                  <Input
                    id="rate-end-date"
                    placeholder="MM-DD"
                    value={form.endDate}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, endDate: e.target.value }));
                    }}
                  />
                </div>
              </div>
            )}

            <DialogFooter>
              <CancelButton
                onClick={() => {
                  setDialogOpen(false);
                }}
              />
              <SaveButton isPending={saveMutation.isPending} />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('sites.deleteElectricityRate')}
        description={t('sites.confirmDeleteElectricityRate')}
        confirmLabel={t('common.delete')}
        variant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget != null) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </Card>
  );
}
