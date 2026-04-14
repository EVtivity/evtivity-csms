// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useMemo, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { SearchInput } from '@/components/search-input';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { ResponsiveFilters } from '@/components/responsive-filters';
import { httpMethodVariant, httpStatusVariant, workerStatusVariant } from '@/lib/status-variants';

interface AccessLog {
  id: number;
  userId: string | null;
  driverId: string | null;
  action: string;
  category: string;
  authType: string | null;
  apiKeyName: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  durationMs: number | null;
  remoteAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  userEmail: string | null;
  userFirstName: string | null;
  userLastName: string | null;
}

function userName(log: AccessLog): string {
  if (log.userFirstName || log.userLastName) {
    return [log.userFirstName, log.userLastName].filter(Boolean).join(' ');
  }
  return log.userEmail ?? '-';
}

function DetailRow({ log, colSpan }: { log: AccessLog; colSpan: number }): React.JSX.Element {
  const { t } = useTranslation();
  const meta = log.metadata;
  const body =
    meta != null && typeof meta === 'object' && Object.keys(meta).length > 0 ? meta : null;

  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="bg-muted/30 p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <div>
            <span className="font-medium text-muted-foreground">{t('logs.ipAddress')}: </span>
            <span className="text-xs">{log.remoteAddress ?? '-'}</span>
          </div>
          {log.userAgent != null && (
            <div className="md:col-span-2">
              <span className="font-medium text-muted-foreground">User Agent: </span>
              <span className="text-xs break-all">{log.userAgent}</span>
            </div>
          )}
          {body != null && (
            <div className="md:col-span-2">
              <p className="font-medium text-muted-foreground mb-1">{t('logs.requestBody')}</p>
              <div className="rounded border bg-background p-3 font-mono text-xs whitespace-pre-wrap">
                {JSON.stringify(body, null, 2)}
              </div>
            </div>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function BrowserLogTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const extraParams = useMemo(() => ({ category: 'csms' }), []);

  const {
    data: logs,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<AccessLog>('access-logs-csms', '/v1/access-logs', extraParams);

  return (
    <div className="space-y-4">
      <SearchInput
        value={search}
        onDebouncedChange={setSearch}
        placeholder={t('logs.searchPlaceholder')}
      />

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.timestamp')}</TableHead>
              <TableHead>{t('logs.user')}</TableHead>
              <TableHead>{t('logs.action')}</TableHead>
              <TableHead>{t('logs.ipAddress')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {t('common.loading')}
                </TableCell>
              </TableRow>
            )}
            {logs?.map((log) => (
              <Fragment key={log.id}>
                <TableRow
                  className="cursor-pointer"
                  data-testid={`admin-log-row-${String(log.id)}`}
                  onClick={() => {
                    setExpandedId(expandedId === log.id ? null : log.id);
                  }}
                >
                  <TableCell className="whitespace-nowrap" data-testid="row-click-target">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{userName(log)}</TableCell>
                  <TableCell>{log.action}</TableCell>
                  <TableCell>{log.remoteAddress ?? '-'}</TableCell>
                </TableRow>
                {expandedId === log.id && <DetailRow log={log} colSpan={4} />}
              </Fragment>
            ))}
            {logs?.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {t('logs.noLogs')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

function PortalLogTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const extraParams = useMemo(() => ({ category: 'portal' }), []);

  const {
    data: logs,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<AccessLog>('access-logs-portal', '/v1/access-logs', extraParams);

  return (
    <div className="space-y-4">
      <SearchInput
        value={search}
        onDebouncedChange={setSearch}
        placeholder={t('logs.searchPlaceholder')}
      />

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.timestamp')}</TableHead>
              <TableHead>{t('logs.user')}</TableHead>
              <TableHead>{t('logs.action')}</TableHead>
              <TableHead>{t('logs.ipAddress')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {t('common.loading')}
                </TableCell>
              </TableRow>
            )}
            {logs?.map((log) => (
              <Fragment key={log.id}>
                <TableRow
                  className="cursor-pointer"
                  data-testid={`portal-log-row-${String(log.id)}`}
                  onClick={() => {
                    setExpandedId(expandedId === log.id ? null : log.id);
                  }}
                >
                  <TableCell className="whitespace-nowrap" data-testid="row-click-target">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{userName(log)}</TableCell>
                  <TableCell>{log.action}</TableCell>
                  <TableCell>{log.remoteAddress ?? '-'}</TableCell>
                </TableRow>
                {expandedId === log.id && <DetailRow log={log} colSpan={4} />}
              </Fragment>
            ))}
            {logs?.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {t('logs.noLogs')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

function ApiLogTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filterMethod, setFilterMethod] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const extraParams = useMemo(() => {
    const params: Record<string, string> = { category: 'api' };
    if (filterMethod) params['method'] = filterMethod;
    return params;
  }, [filterMethod]);

  const {
    data: logs,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<AccessLog>('access-logs-api', '/v1/access-logs', extraParams);

  const filteredLogs = useMemo(() => {
    if (!filterStatus || !logs) return logs;
    return logs.filter((log) => {
      if (log.statusCode == null) return false;
      if (filterStatus === '2xx') return log.statusCode >= 200 && log.statusCode < 300;
      if (filterStatus === '4xx') return log.statusCode >= 400 && log.statusCode < 500;
      if (filterStatus === '5xx') return log.statusCode >= 500;
      return true;
    });
  }, [logs, filterStatus]);

  const apiActiveFilterCount = [filterMethod, filterStatus].filter(Boolean).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('logs.searchPlaceholder')}
        />
        <ResponsiveFilters activeCount={apiActiveFilterCount}>
          <Select
            aria-label="Filter by method"
            value={filterMethod}
            onChange={(e) => {
              setFilterMethod(e.target.value);
              setPage(1);
            }}
            className="h-9 w-auto"
          >
            <option value="">{t('logs.allMethods')}</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PATCH">PATCH</option>
            <option value="PUT">PUT</option>
            <option value="DELETE">DELETE</option>
          </Select>
          <Select
            aria-label="Filter by status"
            value={filterStatus}
            onChange={(e) => {
              setFilterStatus(e.target.value);
            }}
            className="h-9 w-auto"
          >
            <option value="">{t('logs.allStatuses')}</option>
            <option value="2xx">2xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
          </Select>
        </ResponsiveFilters>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.timestamp')}</TableHead>
              <TableHead>{t('logs.apiKeyColumn')}</TableHead>
              <TableHead>{t('logs.user')}</TableHead>
              <TableHead>{t('logs.method')}</TableHead>
              <TableHead>{t('logs.path')}</TableHead>
              <TableHead>{t('logs.status')}</TableHead>
              <TableHead>{t('logs.duration')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {t('common.loading')}
                </TableCell>
              </TableRow>
            )}
            {filteredLogs?.map((log) => (
              <Fragment key={log.id}>
                <TableRow
                  className="cursor-pointer"
                  data-testid={`api-log-row-${String(log.id)}`}
                  onClick={() => {
                    setExpandedId(expandedId === log.id ? null : log.id);
                  }}
                >
                  <TableCell className="whitespace-nowrap" data-testid="row-click-target">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{log.apiKeyName ?? '--'}</TableCell>
                  <TableCell>{userName(log)}</TableCell>
                  <TableCell>
                    {log.method != null && (
                      <Badge variant={httpMethodVariant(log.method)}>{log.method}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[300px] truncate">{log.path ?? '-'}</TableCell>
                  <TableCell>
                    {log.statusCode != null && (
                      <Badge variant={httpStatusVariant(log.statusCode)}>{log.statusCode}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {log.durationMs != null ? t('logs.durationMs', { value: log.durationMs }) : '-'}
                  </TableCell>
                </TableRow>
                {expandedId === log.id && <DetailRow log={log} colSpan={7} />}
              </Fragment>
            ))}
            {filteredLogs?.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {t('logs.noLogs')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

interface WorkerJobLog {
  id: number;
  jobName: string;
  queue: string;
  status: string;
  durationMs: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

function WorkerLogTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filterQueue, setFilterQueue] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const extraParams = useMemo(() => {
    const params: Record<string, string> = {};
    if (filterQueue) params['queue'] = filterQueue;
    if (filterStatus) params['status'] = filterStatus;
    return params;
  }, [filterQueue, filterStatus]);

  const {
    data: logs,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<WorkerJobLog>('worker-logs', '/v1/worker-logs', extraParams);

  const workerActiveFilterCount = [filterQueue, filterStatus].filter(Boolean).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('logs.searchPlaceholder')}
        />
        <ResponsiveFilters activeCount={workerActiveFilterCount}>
          <Select
            aria-label="Filter by queue"
            value={filterQueue}
            onChange={(e) => {
              setFilterQueue(e.target.value);
              setPage(1);
            }}
            className="h-9 w-auto"
          >
            <option value="">{t('logs.allQueues')}</option>
            <option value="cron-jobs">cron-jobs</option>
            <option value="load-management">load-management</option>
            <option value="guest-session-events">guest-session-events</option>
          </Select>
          <Select
            aria-label="Filter by status"
            value={filterStatus}
            onChange={(e) => {
              setFilterStatus(e.target.value);
              setPage(1);
            }}
            className="h-9 w-auto"
          >
            <option value="">{t('logs.allStatuses')}</option>
            <option value="started">started</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
          </Select>
        </ResponsiveFilters>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.timestamp')}</TableHead>
              <TableHead>{t('logs.jobName')}</TableHead>
              <TableHead>{t('logs.queue')}</TableHead>
              <TableHead>{t('logs.status')}</TableHead>
              <TableHead>{t('logs.duration')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  {t('common.loading')}
                </TableCell>
              </TableRow>
            )}
            {logs?.map((log) => (
              <Fragment key={log.id}>
                <TableRow
                  className="cursor-pointer"
                  data-testid={`worker-log-row-${String(log.id)}`}
                  onClick={() => {
                    setExpandedId(expandedId === log.id ? null : log.id);
                  }}
                >
                  <TableCell className="whitespace-nowrap" data-testid="row-click-target">
                    {new Date(log.startedAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{log.jobName}</TableCell>
                  <TableCell>{log.queue}</TableCell>
                  <TableCell>
                    <Badge variant={workerStatusVariant(log.status)}>{log.status}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {log.durationMs != null ? t('logs.durationMs', { value: log.durationMs }) : '-'}
                  </TableCell>
                </TableRow>
                {expandedId === log.id && log.error != null && (
                  <TableRow>
                    <TableCell colSpan={5} className="bg-muted/30 p-4">
                      <p className="font-medium text-muted-foreground mb-1">
                        {t('logs.errorDetails')}
                      </p>
                      <p className="text-sm whitespace-pre-wrap">{log.error}</p>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
            {logs?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  {t('logs.noWorkerLogs')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

export function AccessLogs(): React.JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useTab('csms');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('logs.title')}</h1>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="csms">{t('logs.csmsTab')}</TabsTrigger>
          <TabsTrigger value="portal">{t('logs.portalTab')}</TabsTrigger>
          <TabsTrigger value="api">{t('logs.apiTab')}</TabsTrigger>
          <TabsTrigger value="workers">{t('logs.workersTab')}</TabsTrigger>
        </TabsList>

        <TabsContent value="csms">
          <BrowserLogTab />
        </TabsContent>

        <TabsContent value="portal">
          <PortalLogTab />
        </TabsContent>

        <TabsContent value="api">
          <ApiLogTab />
        </TabsContent>

        <TabsContent value="workers">
          <WorkerLogTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
