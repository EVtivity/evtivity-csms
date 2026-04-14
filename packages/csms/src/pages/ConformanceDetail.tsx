// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ResponsiveFilters } from '@/components/responsive-filters';
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
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface StepResult {
  step: number;
  description: string;
  status: 'passed' | 'failed';
  expected?: string;
  actual?: string;
}

interface TestResult {
  id: number;
  testId: string;
  testName: string;
  module: string;
  ocppVersion: string;
  status: string;
  durationMs: number;
  steps: StepResult[] | null;
  error: string | null;
}

interface ModuleSummary {
  module: string;
  ocppVersion: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
}

function testStatusBadge(status: string): React.JSX.Element {
  const variants: Record<string, 'success' | 'destructive' | 'secondary' | 'warning'> = {
    passed: 'success',
    failed: 'destructive',
    skipped: 'secondary',
    error: 'warning',
  };
  return <Badge variant={variants[status] ?? 'secondary'}>{status}</Badge>;
}

export function ConformanceDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { runId } = useParams<{ runId: string }>();
  const [activeTab, setActiveTab] = useTab('modules');
  const [moduleFilter, setModuleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedTests, setExpandedTests] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const [isPolling, setIsPolling] = useState(true);

  const { data: detail, isLoading } = useQuery({
    queryKey: ['octt-runs', runId, moduleFilter, statusFilter],
    queryFn: () => {
      let url = `/v1/octt/runs/${runId ?? ''}`;
      const params = new URLSearchParams();
      if (moduleFilter !== 'all') params.set('module', moduleFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (params.toString() !== '') url += `?${params.toString()}`;
      return api.get<{ run: OcttRun; results: TestResult[] }>(url);
    },
    refetchInterval: isPolling ? 3000 : false,
  });

  const isRunInProgress = detail?.run.status === 'running' || detail?.run.status === 'pending';
  if (!isRunInProgress && isPolling && detail != null) setIsPolling(false);

  const { data: moduleSummary } = useQuery({
    queryKey: ['octt-runs', runId, 'summary'],
    queryFn: () => api.get<ModuleSummary[]>(`/v1/octt/runs/${runId ?? ''}/summary`),
    refetchInterval: isPolling ? 3000 : false,
  });

  const toggleExpand = (id: number): void => {
    setExpandedTests((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const run = detail?.run;
  if (run == null) return <p>{t('conformance.notFound')}</p>;

  const rate = run.totalTests > 0 ? ((run.passed / run.totalTests) * 100).toFixed(1) : '0';
  const modules = [...new Set(detail?.results.map((r) => r.module) ?? [])].sort();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">
        {t('conformance.runDetail')} #{run.id}
      </h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">{t('conformance.total')}</p>
            <p className="text-2xl font-bold">{run.totalTests}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">{t('conformance.passed')}</p>
            <p className="text-2xl font-bold text-success">{run.passed}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">{t('conformance.failed')}</p>
            <p className="text-2xl font-bold text-destructive">{run.failed}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">{t('conformance.skipped')}</p>
            <p className="text-2xl font-bold">{run.skipped}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">{t('conformance.errors')}</p>
            <p className="text-2xl font-bold text-warning">{run.errors}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">{t('conformance.passRate')}</p>
            <p className="text-2xl font-bold">{rate}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground">{t('conformance.duration')}</p>
            <p className="text-2xl font-bold">
              {run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '--'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="modules">{t('conformance.moduleBreakdown')}</TabsTrigger>
          <TabsTrigger value="results">{t('conformance.testResults')}</TabsTrigger>
        </TabsList>

        <TabsContent value="modules">
          {moduleSummary != null && moduleSummary.length > 0 ? (
            (() => {
              const versions = [...new Set(moduleSummary.map((m) => m.ocppVersion))].sort();
              return (
                <Card>
                  <CardContent className="p-6 space-y-6">
                    {versions.map((version) => {
                      const versionModules = moduleSummary.filter((m) => m.ocppVersion === version);
                      return (
                        <div key={version}>
                          <h3 className="text-sm font-semibold text-muted-foreground mb-2">
                            {version === 'ocpp1.6'
                              ? 'OCPP 1.6'
                              : version === 'ocpp2.1'
                                ? 'OCPP 2.1'
                                : version}
                          </h3>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>{t('conformance.module')}</TableHead>
                                <TableHead className="text-right">
                                  {t('conformance.total')}
                                </TableHead>
                                <TableHead className="text-right">
                                  {t('conformance.passed')}
                                </TableHead>
                                <TableHead className="text-right">
                                  {t('conformance.failed')}
                                </TableHead>
                                <TableHead className="text-right">
                                  {t('conformance.passRate')}
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {versionModules.map((m) => (
                                <TableRow key={`${version}-${m.module}`}>
                                  <TableCell className="font-medium">{m.module}</TableCell>
                                  <TableCell className="text-right">{m.total}</TableCell>
                                  <TableCell className="text-right text-success">
                                    {m.passed}
                                  </TableCell>
                                  <TableCell className="text-right text-destructive">
                                    {m.failed}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {m.total > 0
                                      ? `${((m.passed / m.total) * 100).toFixed(0)}%`
                                      : '--'}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              );
            })()
          ) : (
            <p className="text-sm text-muted-foreground py-4">{t('conformance.noModuleData')}</p>
          )}
        </TabsContent>

        <TabsContent value="results">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{t('conformance.testResults')}</CardTitle>
                <ResponsiveFilters
                  activeCount={
                    [
                      moduleFilter !== 'all' ? moduleFilter : '',
                      statusFilter !== 'all' ? statusFilter : '',
                    ].filter(Boolean).length
                  }
                >
                  <Select
                    aria-label="Filter by module"
                    className="w-[180px]"
                    value={moduleFilter}
                    onChange={(e) => {
                      setModuleFilter(e.target.value);
                    }}
                  >
                    <option value="all">{t('conformance.allModules')}</option>
                    {modules.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label="Filter by status"
                    className="w-[140px]"
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value);
                    }}
                  >
                    <option value="all">{t('conformance.allStatuses')}</option>
                    <option value="passed">{t('conformance.passed')}</option>
                    <option value="failed">{t('conformance.failed')}</option>
                    <option value="skipped">{t('conformance.skipped')}</option>
                    <option value="error">{t('conformance.errors')}</option>
                  </Select>
                </ResponsiveFilters>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t('conformance.testId')}</TableHead>
                    <TableHead>{t('conformance.testName')}</TableHead>
                    <TableHead>{t('conformance.module')}</TableHead>
                    <TableHead>{t('conformance.status')}</TableHead>
                    <TableHead className="text-right">{t('conformance.duration')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail?.results.slice((page - 1) * pageSize, page * pageSize).map((result) => (
                    <ResultRow
                      key={result.id}
                      result={result}
                      expanded={expandedTests.has(result.id)}
                      onToggle={() => {
                        toggleExpand(result.id);
                      }}
                      t={t}
                    />
                  ))}
                </TableBody>
              </Table>
              {(detail?.results.length ?? 0) > pageSize && (
                <div className="flex items-center justify-between border-t pt-4 mt-4">
                  <p className="text-sm text-muted-foreground">
                    {t('conformance.showing')} {(page - 1) * pageSize + 1}-
                    {Math.min(page * pageSize, detail?.results.length ?? 0)} {t('conformance.of')}{' '}
                    {detail?.results.length ?? 0}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => {
                        setPage((p) => p - 1);
                      }}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      {t('conformance.prev')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page * pageSize >= (detail?.results.length ?? 0)}
                      onClick={() => {
                        setPage((p) => p + 1);
                      }}
                    >
                      {t('conformance.next')}
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ResultRow({
  result,
  expanded,
  onToggle,
  t,
}: {
  result: {
    id: number;
    testId: string;
    testName: string;
    module: string;
    status: string;
    durationMs: number;
    steps:
      | { step: number; description: string; status: string; expected?: string; actual?: string }[]
      | null;
    error: string | null;
  };
  expanded: boolean;
  onToggle: () => void;
  t: TFunction;
}): React.JSX.Element {
  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        data-testid={`conformance-result-row-${result.testId}`}
        onClick={onToggle}
      >
        <TableCell data-testid="row-click-target">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </TableCell>
        <TableCell className="text-xs">{result.testId}</TableCell>
        <TableCell>{result.testName}</TableCell>
        <TableCell>{result.module}</TableCell>
        <TableCell>{testStatusBadge(result.status)}</TableCell>
        <TableCell className="text-right text-xs text-muted-foreground">
          {result.durationMs}ms
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/30 p-4">
            {result.error != null && (
              <p className="text-sm text-destructive mb-2">{result.error}</p>
            )}
            {result.steps != null && result.steps.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>{t('conformance.stepDescription')}</TableHead>
                    <TableHead>{t('conformance.expected')}</TableHead>
                    <TableHead>{t('conformance.actual')}</TableHead>
                    <TableHead>{t('conformance.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.steps.map((step) => (
                    <TableRow key={step.step}>
                      <TableCell>{step.step}</TableCell>
                      <TableCell>{step.description}</TableCell>
                      <TableCell className="text-xs">{step.expected ?? '--'}</TableCell>
                      <TableCell className="text-xs">{step.actual ?? '--'}</TableCell>
                      <TableCell>
                        {step.status === 'passed' ? (
                          <CheckCircle className="h-4 w-4 text-success" />
                        ) : (
                          <XCircle className="h-4 w-4 text-destructive" />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">{t('conformance.noSteps')}</p>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
