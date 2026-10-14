// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { useInsightWrongVotes, WRONG_VOTES_PAGE_SIZE } from './insight-api';

/**
 * Marked Wrong on the insight page (owner decision 2026-10-14): the wrong
 * votes on the insight, newest first, with who voted, when, and the note
 * (plain text, never markdown or links) or "No note". A voter the viewer's
 * site access hides shows as "Another user". Shown only when the insight has
 * wrong votes; `aiInsights:read`, the insight's own site scope.
 */
export function InsightWrongVotesCard({
  insightId,
  wrongCount,
}: {
  insightId: string;
  wrongCount: number;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const [page, setPage] = useState(1);
  const { votes, total, isLoading, isError, refetch } = useInsightWrongVotes(
    insightId,
    page,
    wrongCount > 0,
  );
  if (wrongCount === 0) return null;
  const totalPages = Math.max(1, Math.ceil(total / WRONG_VOTES_PAGE_SIZE));
  return (
    <Card data-testid="ai-insight-wrong-votes">
      <CardHeader>
        <CardTitle className="text-base">{t('aiInsights.wrongVotes.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {isLoading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : isError ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-destructive">{t('common.loadError')}</span>
            <Button type="button" size="sm" variant="outline" onClick={refetch}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <ul className="divide-y">
            {votes.map((vote, index) => (
              <li
                key={`${vote.userId ?? 'hidden'}-${vote.votedAt}-${String(index)}`}
                className="space-y-1 py-3 first:pt-0 last:pb-0"
                data-testid="ai-insight-wrong-vote"
              >
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="font-semibold">
                    {vote.userName ?? t('aiInsights.wrongVotes.anotherUser')}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDateTime(vote.votedAt, timezone)}
                  </span>
                </div>
                {vote.note != null && vote.note !== '' ? (
                  <p
                    className="max-w-[65ch] whitespace-pre-line break-words"
                    data-testid="ai-insight-wrong-vote-note"
                  >
                    {vote.note}
                  </p>
                ) : (
                  <p className="text-muted-foreground">{t('aiInsights.wrongVotes.noNote')}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </CardContent>
    </Card>
  );
}
