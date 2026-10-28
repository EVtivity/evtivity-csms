// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiInsightScopeMode } from '@evtivity/lib/ai-insights';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClearableInput } from '@/components/ui/clearable-input';
import { Collapsible } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmToggle } from '@/components/ui/confirm-toggle';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

export interface ScopeSite {
  id: string;
  name: string;
  selected: boolean;
  stationCount: number;
  stationsTurnedOff: number;
}

export interface AiInsightScopeData {
  mode: AiInsightScopeMode;
  sites: ScopeSite[];
  stationsWithoutSite: number;
}

interface ScopeStation {
  id: string;
  stationId: string;
  enabled: boolean;
}

export const AI_INSIGHT_SCOPE_KEY = ['settings', 'ai-insights-scope'] as const;

const SITES_PER_PAGE = 20;

/**
 * The stations of one site, loaded when its row opens. A station's switch
 * follows the site: it is disabled while the site is not selected.
 */
function ScopeStations({
  siteId,
  siteSelected,
  disabled,
  stationDraft,
  onStationChange,
}: {
  siteId: string;
  siteSelected: boolean;
  disabled: boolean;
  stationDraft: ReadonlyMap<string, boolean>;
  onStationChange: (stationId: string, enabled: boolean, stored: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [...AI_INSIGHT_SCOPE_KEY, 'stations', siteId],
    queryFn: () =>
      api.get<ScopeStation[]>(
        `/v1/settings/ai/insights-scope/sites/${encodeURIComponent(siteId)}/stations`,
      ),
    staleTime: 60_000,
  });
  if (isLoading) return <Spinner />;
  if (isError || data == null) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        {t('settings.aiInsightsScope.stationsFailed')}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refetch();
          }}
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t('settings.aiInsightsScope.noStations')}</p>
    );
  }
  return (
    <ul className="divide-y rounded-lg border" data-testid={`ai-scope-stations-${siteId}`}>
      {data.map((s) => {
        const on = stationDraft.get(s.id) ?? s.enabled;
        const id = `ai-scope-station-${s.id}`;
        return (
          <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-2">
            <Label htmlFor={id} className="min-w-0 break-all font-normal">
              {s.stationId}
            </Label>
            <ConfirmToggle
              id={id}
              label={s.stationId}
              offDescription={t('settings.aiInsightsScope.stationOff')}
              checked={siteSelected && on}
              disabled={disabled || !siteSelected}
              onCheckedChange={(checked) => {
                onStationChange(s.id, checked, s.enabled);
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Settings > AI > Automatic Insights: which sites, and inside them which
 * stations, automatic insights and the background workers analyze. All Sites
 * (the default) or Selected Sites: a searchable site list where each site
 * opens to its stations. One Save for the card; it sends only what changed
 * (`PUT /v1/settings/ai/insights-scope`). Disabled, values kept, while
 * system-initiated AI is off (`opsOff`).
 */
export function AiInsightsScopeCard({
  canWrite,
  opsOff,
}: {
  canWrite: boolean;
  opsOff: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: AI_INSIGHT_SCOPE_KEY,
    queryFn: () => api.get<AiInsightScopeData>('/v1/settings/ai/insights-scope'),
    staleTime: 60_000,
  });
  const [mode, setMode] = useState<AiInsightScopeMode>('all');
  const [siteDraft, setSiteDraft] = useState<Map<string, boolean>>(new Map());
  const [stationDraft, setStationDraft] = useState<Map<string, boolean>>(new Map());
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const siteListRef = useRef<HTMLDivElement>(null);
  const storedMode = data?.mode;
  useEffect(() => {
    if (storedMode != null) setMode(storedMode);
  }, [storedMode]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/v1/settings/ai/insights-scope', {
        mode,
        ...(mode === 'selected'
          ? {
              sites: [...siteDraft].map(([siteId, selected]) => ({ siteId, selected })),
              stations: [...stationDraft].map(([stationId, enabled]) => ({ stationId, enabled })),
            }
          : {}),
      }),
    onSuccess: () => {
      setSiteDraft(new Map());
      setStationDraft(new Map());
      void queryClient.invalidateQueries({ queryKey: AI_INSIGHT_SCOPE_KEY });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
      void queryClient.invalidateQueries({ queryKey: ['ai', 'insights'] });
    },
  });

  const sites = useMemo(() => {
    const all = data?.sites ?? [];
    const q = search.trim().toLowerCase();
    return q === '' ? all : all.filter((s) => s.name.toLowerCase().includes(q));
  }, [data, search]);
  const pageCount = Math.max(1, Math.ceil(sites.length / SITES_PER_PAGE));
  const shown = sites.slice((page - 1) * SITES_PER_PAGE, page * SITES_PER_PAGE);

  const disabled = !canWrite || opsOff;
  const dirty =
    storedMode != null &&
    (mode !== storedMode || (mode === 'selected' && (siteDraft.size > 0 || stationDraft.size > 0)));

  const changeSite = (site: ScopeSite, selected: boolean): void => {
    setSiteDraft((prev) => {
      const next = new Map(prev);
      if (selected === site.selected) next.delete(site.id);
      else next.set(site.id, selected);
      return next;
    });
    save.reset();
  };
  const changeStation = (stationId: string, enabled: boolean, stored: boolean): void => {
    setStationDraft((prev) => {
      const next = new Map(prev);
      if (enabled === stored) next.delete(stationId);
      else next.set(stationId, enabled);
      return next;
    });
    save.reset();
  };

  return (
    <Card data-testid="ai-insights-scope">
      <CardHeader>
        <CardTitle>{t('settings.aiInsightsScope.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('settings.aiInsightsScope.description')}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        {opsOff && (
          <p className="text-sm text-muted-foreground" data-testid="ai-insights-scope-ops-off">
            {t('settings.aiSurface.ops.offNote')}
          </p>
        )}
        {isLoading && <Spinner />}
        {isError && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            {t('settings.aiInsightsScope.loadFailed')}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        )}
        {data != null && (
          <>
            <fieldset className="space-y-2" disabled={disabled}>
              <legend className="sr-only">{t('settings.aiInsightsScope.title')}</legend>
              {(['all', 'selected'] as const).map((m) => (
                <label key={m} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="ai-insights-scope-mode"
                    className="mt-1"
                    value={m}
                    checked={mode === m}
                    onChange={() => {
                      setMode(m);
                      save.reset();
                    }}
                  />
                  <span className="space-y-0.5">
                    <span className="block font-medium">
                      {t(`settings.aiInsightsScope.mode.${m}`)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`settings.aiInsightsScope.modeHint.${m}`)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {mode === 'selected' && (
              <div className="space-y-4">
                <ClearableInput
                  aria-label={t('settings.aiInsightsScope.search')}
                  placeholder={t('settings.aiInsightsScope.search')}
                  value={search}
                  onChange={(value) => {
                    setSearch(value);
                    setPage(1);
                  }}
                />
                {data.stationsWithoutSite > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('settings.aiInsightsScope.stationsWithoutSite', {
                      count: data.stationsWithoutSite,
                    })}
                  </p>
                )}
                {shown.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('settings.aiInsightsScope.noSites')}
                  </p>
                ) : (
                  // A fixed height with its own scroll: expanding a site's stations never grows the card.
                  <div
                    ref={siteListRef}
                    className="h-96 overflow-y-auto overscroll-contain rounded-lg border p-3"
                    role="region"
                    aria-label={t('settings.aiInsightsScope.siteListLabel')}
                    tabIndex={0}
                    data-testid="ai-insights-scope-sites-scroll"
                  >
                    <ul className="space-y-2" data-testid="ai-insights-scope-sites">
                      {shown.map((site) => {
                        const selected = siteDraft.get(site.id) ?? site.selected;
                        const toggleId = `ai-scope-site-${site.id}`;
                        return (
                          <li key={site.id} className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <Collapsible
                                title={site.name}
                                summary={t('settings.aiInsightsScope.stationsSummary', {
                                  count: site.stationCount,
                                  off: site.stationsTurnedOff,
                                })}
                                data-testid={`ai-scope-site-${site.id}`}
                              >
                                <div className="pt-2">
                                  <ScopeStations
                                    siteId={site.id}
                                    siteSelected={selected}
                                    disabled={disabled}
                                    stationDraft={stationDraft}
                                    onStationChange={changeStation}
                                  />
                                </div>
                              </Collapsible>
                            </div>
                            <ConfirmToggle
                              id={toggleId}
                              className="mt-2"
                              label={site.name}
                              offDescription={t('settings.aiInsightsScope.siteOff')}
                              aria-label={t('settings.aiInsightsScope.siteToggle', {
                                name: site.name,
                              })}
                              checked={selected}
                              disabled={disabled}
                              onCheckedChange={(checked) => {
                                changeSite(site, checked);
                              }}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {pageCount > 1 && (
                  <Pagination
                    page={page}
                    totalPages={pageCount}
                    onPageChange={(next) => {
                      setPage(next);
                      siteListRef.current?.scrollTo({ top: 0 });
                    }}
                  />
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {t('settings.aiInsightsScope.removeHint')}
            </p>
          </>
        )}
        {save.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(save.error, t, 'settings.aiSaveFailed')}
          </p>
        )}
        {canWrite && data != null && (
          <div className="flex items-center justify-end gap-4">
            {save.isSuccess && !dirty && (
              <p className="text-sm text-success">{t('settings.aiSaved')}</p>
            )}
            {dirty && (
              <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
            )}
            <SaveButton
              isPending={save.isPending}
              disabled={!dirty || opsOff}
              onClick={() => {
                save.mutate();
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
