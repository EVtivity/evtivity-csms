// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { CancelButton } from '@/components/cancel-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatEnergy, formatNumberUpTo } from '@/lib/formatting';
import { formatDateTime } from '@/lib/timezone';
import { OCPP21_ONLY_MONITOR_TYPES } from '@evtivity/lib/ocpp-version';
import { Ocpp201Option } from '@/components/ocpp201-option';

interface SchedulePeriod {
  startPeriod: number;
  limit: number;
}

interface ChargingSchedule {
  chargingRateUnit?: string;
  chargingSchedulePeriod?: SchedulePeriod[];
}

export interface EvChargingNeedsRow {
  id: number;
  evseId: number;
  chargingNeeds: Record<string, unknown>;
  departureTime: string | null;
  requestedEnergyTransfer: string | null;
  controlMode: string | null;
  csmsChargingProfile: {
    payload?: { chargingProfile?: { chargingSchedule?: ChargingSchedule[] } };
    renegotiations?: number;
  } | null;
  updatedAt: string;
}

interface EvChargingScheduleRow {
  id: number;
  evseId: number;
  timeBase: string | null;
  chargingSchedule: ChargingSchedule;
  withinLimits: boolean | null;
  createdAt: string;
}

interface MonitoringRule {
  id: number;
  monitoringId: number | null;
  component: string;
  variable: string;
  type: string;
  value: string;
  severity: number;
  status: string;
  errorInfo: string | null;
  createdAt: string;
}

const MONITOR_TYPES = [
  'UpperThreshold',
  'LowerThreshold',
  'Delta',
  'Periodic',
  'PeriodicClockAligned',
  'TargetDelta',
  'TargetDeltaRelative',
] as const;

const POSITIVE_VALUE_TYPES: ReadonlySet<string> = new Set([
  'Delta',
  'Periodic',
  'PeriodicClockAligned',
]);

const RULE_STATUS_VARIANTS: Record<string, 'default' | 'outline' | 'destructive' | 'secondary'> = {
  pending: 'outline',
  active: 'default',
  error: 'destructive',
  cleared: 'secondary',
};

const RULE_STATUS_LABELS = {
  pending: 'stationChargingNeeds.status.pending',
  active: 'stationChargingNeeds.status.active',
  error: 'stationChargingNeeds.status.error',
  cleared: 'stationChargingNeeds.status.cleared',
} as const;

function ruleStatusLabel(
  status: string,
): (typeof RULE_STATUS_LABELS)[keyof typeof RULE_STATUS_LABELS] {
  return status in RULE_STATUS_LABELS
    ? RULE_STATUS_LABELS[status as keyof typeof RULE_STATUS_LABELS]
    : RULE_STATUS_LABELS.pending;
}

/** The energy the EV asks for (Wh): ISO 15118-2 AC or DC energyAmount, or the -20 target. */
export function requestedEnergyWh(needs: Record<string, unknown>): number | null {
  for (const [key, field] of [
    ['acChargingParameters', 'energyAmount'],
    ['dcChargingParameters', 'energyAmount'],
    ['v2xChargingParameters', 'evTargetEnergyRequest'],
  ] as const) {
    const params = needs[key] as Record<string, unknown> | undefined;
    const value = params?.[field];
    if (typeof value === 'number' && value > 0) return value;
  }
  return null;
}

/** A schedule limit with its unit: W shown as kW, A as A. */
export function formatLimit(limit: number, unit: string | undefined): string {
  return unit === 'A'
    ? `${formatNumberUpTo(limit, 1)} A`
    : `${formatNumberUpTo(limit / 1000, 2)} kW`;
}

function firstLimit(schedule: ChargingSchedule | undefined): string | null {
  const period = schedule?.chargingSchedulePeriod?.[0];
  return period != null ? formatLimit(period.limit, schedule?.chargingRateUnit) : null;
}

interface StationChargingNeedsTabProps {
  stationId: string;
  isOnline: boolean;
  timezone: string;
  ocppProtocol?: string | null;
}

export function StationChargingNeedsTab({
  stationId,
  isOnline,
  timezone,
  ocppProtocol = null,
}: StationChargingNeedsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const is201 = ocppProtocol === 'ocpp2.0.1';
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canWrite = useHasPermission('stations:write');
  const [schedulePage, setSchedulePage] = useState(1);
  const [rulePage, setRulePage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [clearTarget, setClearTarget] = useState<MonitoringRule | null>(null);
  const [component, setComponent] = useState('');
  const [variable, setVariable] = useState('');
  const [type, setType] = useState<string>('UpperThreshold');
  const [value, setValue] = useState('');
  const [severity, setSeverity] = useState('0');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const limit = 10;

  const { data: needs } = useQuery({
    queryKey: ['stations', stationId, 'ev-charging-needs'],
    queryFn: () => api.get<EvChargingNeedsRow[]>(`/v1/stations/${stationId}/ev-charging-needs`),
  });

  const { data: schedules } = useQuery({
    queryKey: ['stations', stationId, 'ev-charging-schedules', schedulePage],
    queryFn: () =>
      api.get<{ data: EvChargingScheduleRow[]; total: number }>(
        `/v1/stations/${stationId}/ev-charging-schedules?page=${String(schedulePage)}&limit=${String(limit)}`,
      ),
  });

  const { data: rules } = useQuery({
    queryKey: ['stations', stationId, 'monitoring-rules', rulePage],
    queryFn: () =>
      api.get<{ data: MonitoringRule[]; total: number }>(
        `/v1/stations/${stationId}/monitoring-rules?page=${String(rulePage)}&limit=${String(limit)}`,
      ),
  });

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<MonitoringRule>(`/v1/stations/${stationId}/monitoring-rules`, body),
    onSuccess: () => {
      setCreateOpen(false);
      setHasSubmitted(false);
      setComponent('');
      setVariable('');
      setValue('');
      setSeverity('0');
    },
    onError: (err: unknown) => {
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
    // A refused monitor is stored as error too: refresh either way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', stationId, 'monitoring-rules'] });
    },
  });

  const clearMutation = useMutation({
    mutationFn: (ruleId: number) =>
      api.delete(`/v1/stations/${stationId}/monitoring-rules/${String(ruleId)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', stationId, 'monitoring-rules'] });
    },
    onError: (err: unknown) => {
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (component.trim() === '') errors.component = t('validation.required');
    if (variable.trim() === '') errors.variable = t('validation.required');
    const numeric = Number(value);
    if (value.trim() === '' || !Number.isFinite(numeric)) {
      errors.value = t('validation.required');
    } else if (POSITIVE_VALUE_TYPES.has(type) && numeric <= 0) {
      errors.value = t('stationChargingNeeds.valueMustBePositive');
    }
    return errors;
  }
  const errors = getValidationErrors();

  function handleCreate(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    createMutation.mutate({
      component: component.trim(),
      variable: variable.trim(),
      type,
      value: Number(value),
      severity: Number(severity),
    });
  }

  const needsRows = needs ?? [];
  const scheduleRows = schedules?.data ?? [];
  const ruleRows = rules?.data ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('stationChargingNeeds.needsTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {needsRows.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              {t('stationChargingNeeds.noNeeds')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('stationChargingNeeds.evse')}</TableHead>
                  <TableHead>{t('stationChargingNeeds.energyTransfer')}</TableHead>
                  <TableHead>{t('stationChargingNeeds.controlMode')}</TableHead>
                  <TableHead>{t('stationChargingNeeds.requestedEnergy')}</TableHead>
                  <TableHead>{t('stationChargingNeeds.departureTime')}</TableHead>
                  <TableHead>{t('stationChargingNeeds.csmsLimit')}</TableHead>
                  <TableHead>{t('stationChargingNeeds.updated')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {needsRows.map((row) => {
                  const energy = requestedEnergyWh(row.chargingNeeds);
                  const csmsLimit = firstLimit(
                    row.csmsChargingProfile?.payload?.chargingProfile?.chargingSchedule?.[0],
                  );
                  return (
                    <TableRow key={row.id}>
                      <TableCell>{String(row.evseId)}</TableCell>
                      <TableCell>{row.requestedEnergyTransfer ?? '-'}</TableCell>
                      <TableCell>{row.controlMode ?? '-'}</TableCell>
                      <TableCell>{energy != null ? formatEnergy(energy) : '-'}</TableCell>
                      <TableCell>
                        {row.departureTime != null
                          ? formatDateTime(row.departureTime, timezone)
                          : '-'}
                      </TableCell>
                      <TableCell>{csmsLimit ?? t('stationChargingNeeds.noProfileSent')}</TableCell>
                      <TableCell>{formatDateTime(row.updatedAt, timezone)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('stationChargingNeeds.schedulesTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {scheduleRows.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              {t('stationChargingNeeds.noSchedules')}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('stationChargingNeeds.evse')}</TableHead>
                    <TableHead>{t('stationChargingNeeds.timeBase')}</TableHead>
                    <TableHead>{t('stationChargingNeeds.firstLimit')}</TableHead>
                    <TableHead>{t('stationChargingNeeds.periods')}</TableHead>
                    <TableHead>{t('stationChargingNeeds.check')}</TableHead>
                    <TableHead>{t('stationChargingNeeds.received')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scheduleRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{String(row.evseId)}</TableCell>
                      <TableCell>
                        {row.timeBase != null ? formatDateTime(row.timeBase, timezone) : '-'}
                      </TableCell>
                      <TableCell>{firstLimit(row.chargingSchedule) ?? '-'}</TableCell>
                      <TableCell>
                        {String(row.chargingSchedule.chargingSchedulePeriod?.length ?? 0)}
                      </TableCell>
                      <TableCell>
                        {row.withinLimits == null ? (
                          <Badge variant="outline">{t('stationChargingNeeds.notChecked')}</Badge>
                        ) : row.withinLimits ? (
                          <Badge variant="default">{t('stationChargingNeeds.withinLimits')}</Badge>
                        ) : (
                          <Badge variant="destructive">
                            {t('stationChargingNeeds.exceedsLimits')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{formatDateTime(row.createdAt, timezone)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-4">
                <Pagination
                  page={schedulePage}
                  totalPages={Math.max(1, Math.ceil((schedules?.total ?? 0) / limit))}
                  onPageChange={setSchedulePage}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col md:flex-row items-start md:items-center justify-between gap-2 md:gap-4">
          <CardTitle>{t('stationChargingNeeds.monitorsTitle')}</CardTitle>
          {canWrite && (
            <Button
              variant="outline"
              size="sm"
              disabled={!isOnline}
              title={isOnline ? undefined : t('stationChargingNeeds.stationOffline')}
              onClick={() => {
                setHasSubmitted(false);
                setCreateOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              {t('stationChargingNeeds.addMonitor')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {ruleRows.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              {t('stationChargingNeeds.noMonitors')}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('stationChargingNeeds.component')}</TableHead>
                    <TableHead>{t('stationChargingNeeds.variable')}</TableHead>
                    <TableHead>{t('stationChargingNeeds.monitorType')}</TableHead>
                    <TableHead>{t('stationChargingNeeds.value')}</TableHead>
                    <TableHead>{t('stationChargingNeeds.severity')}</TableHead>
                    <TableHead>{t('stationChargingNeeds.monitorId')}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead>{t('common.created')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ruleRows.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell>{rule.component}</TableCell>
                      <TableCell>{rule.variable}</TableCell>
                      <TableCell>{rule.type}</TableCell>
                      <TableCell>{rule.value}</TableCell>
                      <TableCell>{String(rule.severity)}</TableCell>
                      <TableCell>
                        {rule.monitoringId != null ? String(rule.monitoringId) : '-'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={RULE_STATUS_VARIANTS[rule.status] ?? 'outline'}
                          title={rule.errorInfo ?? undefined}
                        >
                          {t(ruleStatusLabel(rule.status))}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDateTime(rule.createdAt, timezone)}</TableCell>
                      <TableCell>
                        {canWrite && rule.status !== 'cleared' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('stationChargingNeeds.clearMonitor')}
                            disabled={clearMutation.isPending}
                            onClick={() => {
                              setClearTarget(rule);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-4">
                <Pagination
                  page={rulePage}
                  totalPages={Math.max(1, Math.ceil((rules?.total ?? 0) / limit))}
                  onPageChange={setRulePage}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('stationChargingNeeds.addMonitor')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} noValidate className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="monitor-component" className="leading-6">
                  {t('stationChargingNeeds.component')}
                </Label>
                <Input
                  id="monitor-component"
                  value={component}
                  maxLength={50}
                  placeholder="EVSE"
                  onChange={(e) => {
                    setComponent(e.target.value);
                  }}
                  className={hasSubmitted && errors.component ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.component && (
                  <p className="text-sm text-destructive">{errors.component}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="monitor-variable" className="leading-6">
                  {t('stationChargingNeeds.variable')}
                </Label>
                <Input
                  id="monitor-variable"
                  value={variable}
                  maxLength={50}
                  placeholder="Power"
                  onChange={(e) => {
                    setVariable(e.target.value);
                  }}
                  className={hasSubmitted && errors.variable ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.variable && (
                  <p className="text-sm text-destructive">{errors.variable}</p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="monitor-type" className="leading-6">
                  {t('stationChargingNeeds.monitorType')}
                </Label>
                <Select
                  id="monitor-type"
                  value={type}
                  onChange={(e) => {
                    setType(e.target.value);
                  }}
                >
                  {MONITOR_TYPES.map((m) => (
                    <Ocpp201Option
                      key={m}
                      value={m}
                      unavailable={is201 && OCPP21_ONLY_MONITOR_TYPES.includes(m)}
                    />
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="monitor-value" className="leading-6">
                  {t('stationChargingNeeds.value')}
                </Label>
                <Input
                  id="monitor-value"
                  type="number"
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                  }}
                  className={hasSubmitted && errors.value ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.value && (
                  <p className="text-sm text-destructive">{errors.value}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="monitor-severity" className="leading-6">
                  {t('stationChargingNeeds.severity')}
                </Label>
                <Select
                  id="monitor-severity"
                  value={severity}
                  onChange={(e) => {
                    setSeverity(e.target.value);
                  }}
                >
                  {Array.from({ length: 10 }, (_, i) => (
                    <option key={i} value={String(i)}>
                      {String(i)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <DialogFooter>
              <CancelButton
                onClick={() => {
                  setCreateOpen(false);
                }}
              />
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? t('common.creating') : t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={clearTarget != null}
        onOpenChange={(open) => {
          if (!open) setClearTarget(null);
        }}
        title={t('stationChargingNeeds.clearMonitor')}
        description={t('stationChargingNeeds.confirmClearMonitor')}
        confirmLabel={t('stationChargingNeeds.clearMonitor')}
        onConfirm={() => {
          if (clearTarget != null) clearMutation.mutate(clearTarget.id);
        }}
      />
    </div>
  );
}
