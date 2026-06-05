// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
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

interface OcttRun {
  id: number;
  status: string;
  ocppVersion: string;
  sutType: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  durationMs: number | null;
  triggeredBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

function statusBadge(status: string): React.JSX.Element {
  const variants: Record<string, 'success' | 'destructive' | 'secondary' | 'warning' | 'default'> =
    {
      completed: 'success',
      failed: 'destructive',
      pending: 'secondary',
      running: 'warning',
    };
  return <Badge variant={variants[status] ?? 'default'}>{status}</Badge>;
}

function passRate(run: OcttRun): string {
  if (run.totalTests === 0) return 'n/a';
  return `${((run.passed / run.totalTests) * 100).toFixed(1)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes)}m ${String(remainingSeconds)}s`;
}

export function Conformance({ embedded }: { embedded?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedVersion, setSelectedVersion] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['octt-runs'],
    queryFn: () => api.get<{ data: OcttRun[]; total: number }>('/v1/octt/runs?limit=50'),
    refetchInterval: (query) => {
      const runs = query.state.data?.data;
      if (runs?.some((r) => r.status === 'running' || r.status === 'pending')) return 3000;
      return false;
    },
  });

  const hasRunningRun = data?.data.some((r) => r.status === 'running' || r.status === 'pending');

  const triggerRun = useMutation({
    mutationFn: (body: { ocppVersion: string; sutType: string }) =>
      api.post<OcttRun>('/v1/octt/runs', body),
    onSuccess: () => {
      toast({ variant: 'success', title: t('conformance.runStarted') });
      void queryClient.invalidateQueries({ queryKey: ['octt-runs'] });
    },
    onError: (err: unknown) => {
      const message =
        err != null && typeof err === 'object' && 'body' in err
          ? ((err as { body: { error?: string } }).body.error ?? t('common.requestFailed'))
          : t('common.requestFailed');
      toast({ variant: 'destructive', title: message });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 [&>*]:w-full sm:flex-row sm:items-start sm:justify-between sm:[&>*]:w-auto">
        {!embedded && (
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">{t('conformance.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('conformance.subtitle')}</p>
          </div>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <Select
            aria-label={t('conformance.ocppVersion')}
            className="w-[140px]"
            value={selectedVersion}
            onChange={(e) => {
              setSelectedVersion(e.target.value);
            }}
          >
            <option value="all">{t('conformance.runAll')}</option>
            <option value="ocpp2.1">OCPP 2.1</option>
            <option value="ocpp1.6">OCPP 1.6</option>
          </Select>
          <Button
            disabled={hasRunningRun === true || triggerRun.isPending}
            onClick={() => {
              triggerRun.mutate({ ocppVersion: selectedVersion, sutType: 'csms' });
            }}
            className="relative"
          >
            {triggerRun.isPending && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Spinner className="h-4 w-4" />
              </div>
            )}
            <span
              className={
                triggerRun.isPending
                  ? 'invisible flex items-center gap-2'
                  : 'flex items-center gap-2'
              }
            >
              <Play className="h-4 w-4" />
              {t('conformance.runTests')}
            </span>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="h-6 w-6" />
            </div>
          ) : (data?.data.length ?? 0) === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">
              {t('conformance.noRuns')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('conformance.date')}</TableHead>
                    <TableHead>{t('conformance.version')}</TableHead>
                    <TableHead>{t('conformance.status')}</TableHead>
                    <TableHead className="text-right">{t('conformance.passed')}</TableHead>
                    <TableHead className="text-right">{t('conformance.failed')}</TableHead>
                    <TableHead className="text-right">{t('conformance.errors')}</TableHead>
                    <TableHead className="text-right">{t('conformance.passRate')}</TableHead>
                    <TableHead className="text-right">{t('conformance.duration')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.data.map((run) => (
                    <TableRow
                      key={run.id}
                      className="cursor-pointer hover:bg-muted/50"
                      data-testid={`conformance-run-row-${String(run.id)}`}
                      onClick={() => {
                        void navigate(`/conformance/${String(run.id)}`);
                      }}
                    >
                      <TableCell className="text-xs" data-testid="row-click-target">
                        {new Date(run.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{run.ocppVersion}</Badge>
                      </TableCell>
                      <TableCell>{statusBadge(run.status)}</TableCell>
                      <TableCell className="text-right text-success">{run.passed}</TableCell>
                      <TableCell className="text-right text-destructive">{run.failed}</TableCell>
                      <TableCell className="text-right text-warning">
                        {run.skipped + run.errors}
                      </TableCell>
                      <TableCell className="text-right font-medium">{passRate(run)}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {formatDuration(run.durationMs)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
