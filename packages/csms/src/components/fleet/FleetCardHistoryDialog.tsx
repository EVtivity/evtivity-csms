// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/content-state';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

export type FleetCardChange =
  | 'added'
  | 'moved_into_fleet'
  | 'moved_out_of_fleet'
  | 'given'
  | 'taken_back'
  | 'renamed'
  | 'limit_changed'
  | 'turned_off'
  | 'turned_on'
  | 'deactivated'
  | 'changed'
  | 'deleted';

interface HistoryMember {
  id: string;
  name: string | null;
  erased: boolean;
}

export interface FleetCardHistoryEntry {
  id: number;
  createdAt: string;
  changes: FleetCardChange[];
  reason: 'member_left' | null;
  memberBefore: HistoryMember | null;
  memberAfter: HistoryMember | null;
  labelBefore: string | null;
  labelAfter: string | null;
  actor: {
    kind: 'fleet_user' | 'operator' | 'driver' | 'system';
    name: string | null;
    viaApiKey: boolean;
  };
}

const PAGE_SIZE = 10;

function memberText(member: HistoryMember | null, t: TFunction): string {
  if (member == null) return t('fleets.cards.history.someMember');
  if (member.erased) return t('drivers.erasedName');
  return member.name ?? t('fleets.cards.history.someMember');
}

/** One readable line per change of a history entry. */
export function historyChangeLines(entry: FleetCardHistoryEntry, t: TFunction): string[] {
  return entry.changes.map((change) => {
    switch (change) {
      case 'given':
        return t('fleets.cards.history.change.given', {
          member: memberText(entry.memberAfter, t),
        });
      case 'taken_back':
        return t('fleets.cards.history.change.taken_back', {
          member: memberText(entry.memberBefore, t),
        });
      case 'renamed':
        return t('fleets.cards.history.change.renamed', {
          from: entry.labelBefore ?? t('fleets.cards.history.noLabel'),
          to: entry.labelAfter ?? t('fleets.cards.history.noLabel'),
        });
      default:
        return t(`fleets.cards.history.change.${change}`);
    }
  });
}

/** Who made the change: a name when the reader may see it, else the kind of person. */
export function historyActorText(entry: FleetCardHistoryEntry, t: TFunction): string {
  const who = entry.actor.name ?? t(`fleets.cards.history.actor.${entry.actor.kind}`);
  return entry.actor.viaApiKey ? t('fleets.cards.history.viaApiKey', { who }) : who;
}

interface FleetCardHistoryDialogProps {
  fleetId: string;
  card: { id: string; idToken: string };
  onClose: () => void;
}

/** The changes to one fleet RFID card while it belonged to the fleet, newest first. */
export function FleetCardHistoryDialog({
  fleetId,
  card,
  onClose,
}: FleetCardHistoryDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['fleets', fleetId, 'cards', card.id, 'history', page],
    queryFn: () =>
      api.get<{ data: FleetCardHistoryEntry[]; total: number }>(
        `/v1/fleets/${fleetId}/cards/${card.id}/history?${query.toString()}`,
      ),
  });
  const rows = data?.data ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent scrollable className="max-w-[95vw] md:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('fleets.cards.history.title')}</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {t('fleets.cards.history.description', { value: card.idToken })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="min-w-0 space-y-3">
          {isLoading && <LoadingState />}
          {isError && (
            <ErrorState
              onRetry={() => {
                void refetch();
              }}
            />
          )}
          {!isLoading && !isError && rows.length === 0 && (
            <EmptyState>{t('fleets.cards.history.empty')}</EmptyState>
          )}
          {rows.length > 0 && (
            <ol className="divide-y divide-border" data-testid="fleet-card-history">
              {rows.map((entry) => (
                <li key={entry.id} className="space-y-1 py-3 first:pt-0">
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(entry.createdAt, timezone)}
                  </p>
                  {historyChangeLines(entry, t).map((line) => (
                    <p key={line} className="text-sm font-medium wrap-anywhere">
                      {line}
                    </p>
                  ))}
                  {entry.reason === 'member_left' && (
                    <p className="text-xs text-muted-foreground">
                      {t('fleets.cards.history.reasonMemberLeft')}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground wrap-anywhere">
                    {t('fleets.cards.history.by', { who: historyActorText(entry, t) })}
                  </p>
                </li>
              ))}
            </ol>
          )}
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
