// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Pagination } from '@/components/ui/pagination';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface Schedule {
  id: number;
  name: string;
  reportType: string;
  format: string;
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  recipientEmails: string[];
  filters: Record<string, string>;
  isEnabled: boolean;
  createdAt: string;
}

const REPORT_TYPES = [
  'revenue',
  'utilization',
  'energy',
  'stationHealth',
  'sessions',
  'sustainability',
  'driverActivity',
] as const;

const FORMATS = ['csv', 'pdf', 'xlsx'] as const;

const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export function SchedulesTab(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const timezone = useUserTimezone();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [schedulePage, setSchedulePage] = useState(1);
  const SCHEDULE_PAGE_SIZE = 10;
  const [deleteId, setDeleteId] = useState<number | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [reportType, setReportType] = useState<string>(REPORT_TYPES[0]);
  const [format, setFormat] = useState<string>(FORMATS[0]);
  const [frequency, setFrequency] = useState<string>(FREQUENCIES[0]);
  const [dayOfWeek, setDayOfWeek] = useState<number>(0);
  const [dayOfMonth, setDayOfMonth] = useState<number>(1);
  const [recipientEmails, setRecipientEmails] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data: schedulesResponse, isLoading } = useQuery({
    queryKey: ['report-schedules'],
    queryFn: () => api.get<{ data: Schedule[] }>('/v1/report-schedules'),
  });

  const schedules = schedulesResponse?.data;

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/v1/report-schedules', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['report-schedules'] });
      closeDialog();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/v1/report-schedules/${String(id)}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['report-schedules'] });
      closeDialog();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/v1/report-schedules/${String(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['report-schedules'] });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isEnabled }: { id: number; isEnabled: boolean }) =>
      api.patch(`/v1/report-schedules/${String(id)}`, { isEnabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['report-schedules'] });
    },
  });

  const runNowMutation = useMutation({
    mutationFn: (id: number) =>
      api.post<{ id: string; status: string }>(`/v1/report-schedules/${String(id)}/run-now`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
  });

  function resetForm(): void {
    setName('');
    setReportType(REPORT_TYPES[0]);
    setFormat(FORMATS[0]);
    setFrequency(FREQUENCIES[0]);
    setDayOfWeek(0);
    setDayOfMonth(1);
    setRecipientEmails('');
    setDateFrom('');
    setDateTo('');
    setHasSubmitted(false);
  }

  function closeDialog(): void {
    setDialogOpen(false);
    setEditingSchedule(null);
    resetForm();
  }

  function openCreate(): void {
    resetForm();
    setEditingSchedule(null);
    setDialogOpen(true);
  }

  function openEdit(schedule: Schedule): void {
    setEditingSchedule(schedule);
    setName(schedule.name);
    setReportType(schedule.reportType);
    setFormat(schedule.format);
    setFrequency(schedule.frequency);
    setDayOfWeek(schedule.dayOfWeek ?? 0);
    setDayOfMonth(schedule.dayOfMonth ?? 1);
    setRecipientEmails(schedule.recipientEmails.join(', '));
    setDateFrom(schedule.filters['dateFrom'] ?? '');
    setDateTo(schedule.filters['dateTo'] ?? '');
    setDialogOpen(true);
  }

  function getScheduleValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (name.trim() === '') {
      errors.name = t('validation.required');
    }
    if (recipientEmails.trim() === '') {
      errors.recipientEmails = t('validation.required');
    }
    return errors;
  }

  const scheduleErrors = getScheduleValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(scheduleErrors).length > 0) return;
    const filters: Record<string, string> = {};
    if (dateFrom) filters['dateFrom'] = dateFrom;
    if (dateTo) filters['dateTo'] = dateTo;

    const emails = recipientEmails
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const body: Record<string, unknown> = {
      name,
      reportType,
      format,
      frequency,
      filters,
      recipientEmails: emails,
    };

    if (frequency === 'weekly') {
      body['dayOfWeek'] = dayOfWeek;
    }
    if (frequency === 'monthly') {
      body['dayOfMonth'] = dayOfMonth;
    }

    if (editingSchedule != null) {
      updateMutation.mutate({ id: editingSchedule.id, body });
    } else {
      createMutation.mutate(body);
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        <div className="flex justify-end">
          <CreateButton label={t('reports.createSchedule')} onClick={openCreate} />
        </div>

        {isLoading && <p className="text-muted-foreground">{t('common.loading')}</p>}

        {schedules != null && schedules.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            {t('reports.noSchedules')}
          </p>
        )}

        <div className="space-y-4">
          {schedules
            ?.slice((schedulePage - 1) * SCHEDULE_PAGE_SIZE, schedulePage * SCHEDULE_PAGE_SIZE)
            .map((schedule) => (
              <Card key={schedule.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-lg">{schedule.name}</CardTitle>
                      <Badge variant={schedule.isEnabled ? 'default' : 'secondary'}>
                        {schedule.isEnabled ? t('reports.enabled') : t('reports.disabled')}
                      </Badge>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          toggleMutation.mutate({
                            id: schedule.id,
                            isEnabled: !schedule.isEnabled,
                          });
                        }}
                      >
                        {schedule.isEnabled ? t('reports.disabled') : t('reports.enabled')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          runNowMutation.mutate(schedule.id);
                        }}
                      >
                        {t('reports.runNow')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          openEdit(schedule);
                        }}
                      >
                        {t('reports.editSchedule')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDeleteId(schedule.id);
                        }}
                      >
                        {t('reports.deleteSchedule')}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                    <div>
                      <span className="text-muted-foreground">{t('reports.reportType')}</span>
                      <p>{t(`reports.types.${schedule.reportType}`, schedule.reportType)}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t('reports.format')}</span>
                      <p className="uppercase">{schedule.format}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t('reports.frequency')}</span>
                      <p>{t(`reports.frequencies.${schedule.frequency}`, schedule.frequency)}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t('reports.recipientEmails')}</span>
                      <p>{schedule.recipientEmails.join(', ')}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t('reports.created')}</span>
                      <p>{formatDateTime(schedule.createdAt, timezone)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
        </div>

        {schedules != null && schedules.length > SCHEDULE_PAGE_SIZE && (
          <Pagination
            page={schedulePage}
            totalPages={Math.ceil(schedules.length / SCHEDULE_PAGE_SIZE)}
            onPageChange={setSchedulePage}
          />
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-sm md:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {editingSchedule != null ? t('reports.editSchedule') : t('reports.createSchedule')}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="schedule-name">{t('reports.name')}</Label>
                <Input
                  id="schedule-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                  className={hasSubmitted && scheduleErrors.name ? 'border-destructive' : ''}
                />
                {hasSubmitted && scheduleErrors.name && (
                  <p className="text-sm text-destructive">{scheduleErrors.name}</p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="schedule-type">{t('reports.reportType')}</Label>
                  <Select
                    id="schedule-type"
                    className="h-9"
                    value={reportType}
                    onChange={(e) => {
                      setReportType(e.target.value);
                    }}
                  >
                    {REPORT_TYPES.map((rt) => (
                      <option key={rt} value={rt}>
                        {t(`reports.types.${rt}`, rt)}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="schedule-format">{t('reports.format')}</Label>
                  <Select
                    id="schedule-format"
                    className="h-9"
                    value={format}
                    onChange={(e) => {
                      setFormat(e.target.value);
                    }}
                  >
                    {FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {t(`reports.formats.${f}`, f)}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="schedule-frequency">{t('reports.frequency')}</Label>
                  <Select
                    id="schedule-frequency"
                    className="h-9"
                    value={frequency}
                    onChange={(e) => {
                      setFrequency(e.target.value);
                    }}
                  >
                    {FREQUENCIES.map((f) => (
                      <option key={f} value={f}>
                        {t(`reports.frequencies.${f}`, f)}
                      </option>
                    ))}
                  </Select>
                </div>

                {frequency === 'weekly' && (
                  <div className="space-y-2">
                    <Label htmlFor="schedule-dow">{t('reports.dayOfWeek')}</Label>
                    <Select
                      id="schedule-dow"
                      className="h-9"
                      value={dayOfWeek}
                      onChange={(e) => {
                        setDayOfWeek(Number(e.target.value));
                      }}
                    >
                      {DAY_KEYS.map((day, i) => (
                        <option key={day} value={i}>
                          {t(`reports.days.${day}`, day)}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}

                {frequency === 'monthly' && (
                  <div className="space-y-2">
                    <Label htmlFor="schedule-dom">{t('reports.dayOfMonth')}</Label>
                    <Input
                      id="schedule-dom"
                      type="number"
                      min={1}
                      max={28}
                      value={dayOfMonth}
                      onChange={(e) => {
                        setDayOfMonth(Number(e.target.value));
                      }}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label>{t('reports.dateRange')}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="date"
                    aria-label="Start date"
                    value={dateFrom}
                    onChange={(e) => {
                      setDateFrom(e.target.value);
                    }}
                  />
                  <span className="text-sm text-muted-foreground">{t('dashboard.to')}</span>
                  <Input
                    type="date"
                    aria-label="End date"
                    value={dateTo}
                    onChange={(e) => {
                      setDateTo(e.target.value);
                    }}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="schedule-emails">{t('reports.recipientEmails')}</Label>
                <Input
                  id="schedule-emails"
                  value={recipientEmails}
                  onChange={(e) => {
                    setRecipientEmails(e.target.value);
                  }}
                  placeholder="user@example.com, admin@example.com"
                  className={
                    hasSubmitted && scheduleErrors.recipientEmails ? 'border-destructive' : ''
                  }
                />
                {hasSubmitted && scheduleErrors.recipientEmails && (
                  <p className="text-sm text-destructive">{scheduleErrors.recipientEmails}</p>
                )}
              </div>

              <DialogFooter>
                <CancelButton onClick={closeDialog} />
                {editingSchedule != null ? (
                  <SaveButton isPending={isPending} />
                ) : (
                  <CreateButton label={t('common.create')} type="submit" disabled={isPending} />
                )}
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={deleteId != null}
          onOpenChange={(open) => {
            if (!open) setDeleteId(null);
          }}
          title={t('reports.deleteSchedule')}
          description={t('reports.scheduleDeleted')}
          confirmLabel={t('common.delete')}
          confirmIcon={<Trash2 className="h-4 w-4" />}
          onConfirm={() => {
            if (deleteId != null) {
              deleteMutation.mutate(deleteId);
              setDeleteId(null);
            }
          }}
        />
      </CardContent>
    </Card>
  );
}
