// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { isVisibleInsightStatus } from '@evtivity/lib/ai-insights';
import { LoadingLogo } from '@/components/loading-logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { insightStatusVariant } from '@/lib/status-variants';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import type { InsightFilter } from './insight-api';
import { useInsights } from './insight-api';
import { insightHeadline, shownCategory } from './insight-display';

/**
 * Every automatic insight about one record (a station, session or
 * reservation), newest first: the page's AI Insights tab. A row opens the
 * insight page.
 */
export function RecordInsightsTab({ filter }: { filter: InsightFilter }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const { insights, isLoading, isError, refetch } = useInsights(filter);
  const rows = insights.filter((i) => isVisibleInsightStatus(i.status));

  return (
    <Card>
      <CardContent className="pt-6">
        {isLoading ? (
          <LoadingLogo size="inline" />
        ) : isError ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-destructive">{t('common.loadError')}</p>
            <Button type="button" variant="outline" size="sm" onClick={refetch}>
              {t('common.retry')}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">{t('aiInsights.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('aiInsights.list.insight')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('aiInsights.categoryLabel')}</TableHead>
                  <TableHead>{t('common.created')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((insight) => {
                  const category = shownCategory(insight);
                  return (
                    <TableRow
                      key={insight.id}
                      className="cursor-pointer"
                      data-testid={`record-insight-row-${insight.id}`}
                      onClick={() => {
                        void navigate(`/ai/insights/${encodeURIComponent(insight.id)}`);
                      }}
                    >
                      <TableCell className="font-medium text-link">
                        {insightHeadline(t, insight)}
                      </TableCell>
                      <TableCell data-testid="row-click-target">
                        {isVisibleInsightStatus(insight.status) && (
                          <Badge variant={insightStatusVariant(insight.status)}>
                            {t(`aiInsights.status.${insight.status}`)}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {category != null ? t(`aiInsights.category.${category}`) : t('common.na')}
                      </TableCell>
                      <TableCell>{formatDateTime(insight.createdAt, timezone)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
