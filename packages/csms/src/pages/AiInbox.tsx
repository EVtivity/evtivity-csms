// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useState } from 'react';
import type { TFunction } from 'i18next';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  AI_PROPOSAL_SOURCES,
  AI_PROPOSAL_STATUSES,
  AI_WORKER_JOBS,
} from '@evtivity/lib/ai-proposals';
import type { AiProposalSource, AiProposalStatus, AiWorkerJob } from '@evtivity/lib/ai-proposals';
import { proposalActionLabel } from '@/components/ai/inbox/ProposalCard';
import type { AiProposalView, ProposalFilter } from '@/components/ai/inbox/proposal-api';
import { PROPOSALS_PAGE_SIZE, useProposals } from '@/components/ai/inbox/proposal-api';
import { readProposalSummary } from '@/components/ai/inbox/proposal-summary';
import { LoadingLogo } from '@/components/loading-logo';
import { SearchInput } from '@/components/search-input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { aiProposalStatusVariant } from '@/lib/status-variants';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface SiteOption {
  id: string;
  name: string;
}

const COLUMNS = 7;

/** Who asked: the worker job, or the MCP client (untrusted name, shown as text). */
function sourceLabel(
  t: TFunction,
  proposal: AiProposalView,
): { primary: string; secondary: string } {
  if (proposal.source === 'worker') {
    return {
      primary: proposal.job != null ? t(`aiInbox.job.${proposal.job}`) : t('aiInbox.source.worker'),
      secondary: t('aiInbox.source.worker'),
    };
  }
  const client = proposal.clientName ?? readProposalSummary(proposal.summary).clientName;
  return { primary: client ?? t('aiInbox.source.mcp'), secondary: t('aiInbox.source.mcp') };
}

/**
 * AI Inbox (`/ai/inbox`): what background workers and MCP clients proposed, with the
 * standard filter bar and table. Nothing runs until someone with
 * `aiProposals:write` confirms it on the proposal's page. The API scopes the
 * list (sites; MCP proposals only for their requester) and the
 * `ai.proposal.updated` event refreshes it.
 */
export function AiInbox(): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const canReadSites = useHasPermission('sites:read');
  const [status, setStatus] = useState<AiProposalStatus | ''>('pending');
  const [source, setSource] = useState<AiProposalSource | ''>('');
  const [job, setJob] = useState<AiWorkerJob | ''>('');
  const [siteId, setSiteId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const filter: ProposalFilter = { status, source, job, siteId, search };
  const { proposals, total, isLoading, isError } = useProposals(filter, page);
  const totalPages = Math.max(1, Math.ceil(total / PROPOSALS_PAGE_SIZE));

  const { data: sites } = useQuery({
    queryKey: ['sites', 'options'],
    queryFn: () => api.get<{ data: SiteOption[] }>('/v1/sites?limit=100'),
    enabled: canReadSites,
    staleTime: 60_000,
  });

  const onSearch = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  function change<T>(setter: (v: T) => void): (v: T) => void {
    return (v) => {
      setter(v);
      setPage(1);
    };
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">{t('aiInbox.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('aiInbox.description')}</p>
      </div>

      <Card>
        <CardContent className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3 lg:grid-cols-5">
          <div className="space-y-2">
            <Label htmlFor="ai-inbox-search" className="leading-6">
              {t('aiInbox.filters.search')}
            </Label>
            <SearchInput
              id="ai-inbox-search"
              value={search}
              onDebouncedChange={onSearch}
              placeholder={t('aiInbox.filters.searchPlaceholder')}
              className="h-9 max-w-none"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-inbox-status" className="leading-6">
              {t('aiInbox.filters.status')}
            </Label>
            <Select
              id="ai-inbox-status"
              className="h-9"
              value={status}
              onChange={(e) => {
                change(setStatus)(e.target.value as AiProposalStatus | '');
              }}
            >
              <option value="">{t('aiInbox.filters.all')}</option>
              {AI_PROPOSAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`aiInbox.status.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-inbox-source" className="leading-6">
              {t('aiInbox.filters.source')}
            </Label>
            <Select
              id="ai-inbox-source"
              className="h-9"
              value={source}
              onChange={(e) => {
                change(setSource)(e.target.value as AiProposalSource | '');
              }}
            >
              <option value="">{t('aiInbox.filters.all')}</option>
              {AI_PROPOSAL_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`aiInbox.source.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-inbox-job" className="leading-6">
              {t('aiInbox.filters.job')}
            </Label>
            <Select
              id="ai-inbox-job"
              className="h-9"
              value={job}
              onChange={(e) => {
                change(setJob)(e.target.value as AiWorkerJob | '');
              }}
            >
              <option value="">{t('aiInbox.filters.all')}</option>
              {AI_WORKER_JOBS.map((j) => (
                <option key={j} value={j}>
                  {t(`aiInbox.job.${j}`)}
                </option>
              ))}
            </Select>
          </div>
          {canReadSites && (
            <div className="space-y-2">
              <Label htmlFor="ai-inbox-site" className="leading-6">
                {t('aiInbox.filters.site')}
              </Label>
              <Select
                id="ai-inbox-site"
                className="h-9"
                value={siteId}
                onChange={(e) => {
                  change(setSiteId)(e.target.value);
                }}
              >
                <option value="">{t('aiInbox.filters.all')}</option>
                {(sites?.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table data-testid="ai-inbox-list">
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('aiInbox.columns.action')}</TableHead>
                <TableHead>{t('aiInbox.stationLabel')}</TableHead>
                <TableHead>{t('aiInbox.filters.site')}</TableHead>
                <TableHead>{t('aiInbox.filters.source')}</TableHead>
                <TableHead>{t('common.created')}</TableHead>
                <TableHead>{t('aiInbox.columns.expires')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={COLUMNS}>
                    <LoadingLogo size="inline" />
                  </TableCell>
                </TableRow>
              )}
              {isError && (
                <TableRow>
                  <TableCell colSpan={COLUMNS} className="text-center text-sm text-destructive">
                    {t('common.loadError')}
                  </TableCell>
                </TableRow>
              )}
              {proposals.map((p) => {
                const from = sourceLabel(t, p);
                return (
                  <TableRow
                    key={p.id}
                    className="cursor-pointer"
                    data-testid="ai-inbox-row"
                    onClick={() => {
                      void navigate(`/ai/inbox/${p.id}`);
                    }}
                  >
                    <TableCell>
                      <Badge
                        variant={aiProposalStatusVariant(p.status)}
                        data-testid="ai-proposal-status"
                      >
                        {t(`aiInbox.status.${p.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium text-link">
                      {proposalActionLabel(t, p)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {p.stationId != null ? (
                        <Link
                          to={`/stations/${p.stationId}`}
                          className="hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                        >
                          {p.stationName ?? p.stationId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {p.siteId != null ? (
                        <Link
                          to={`/sites/${p.siteId}`}
                          className="hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                        >
                          {p.siteName ?? p.siteId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="wrap-anywhere">{from.primary}</p>
                      <p className="text-xs text-muted-foreground">{from.secondary}</p>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(p.createdAt, timezone)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {p.status === 'pending' ? (
                        formatDateTime(p.expiresAt, timezone)
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!isLoading && !isError && proposals.length === 0 && (
                <TableRow>
                  <TableCell colSpan={COLUMNS} className="text-center text-muted-foreground">
                    {t('aiInbox.empty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
