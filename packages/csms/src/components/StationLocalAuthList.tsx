// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Search, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { CancelButton } from '@/components/cancel-button';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/timezone';

interface LocalAuthEntry {
  id: number;
  stationId: string;
  driverTokenId: string | null;
  idToken: string;
  tokenType: string;
  authStatus: string;
  addedAt: string;
  pushedAt: string | null;
  createdAt: string;
  updatedAt: string;
  driverName: string | null;
}

interface VersionInfo {
  localVersion: number;
  lastSyncAt: string | null;
  lastModifiedAt: string | null;
  entries: LocalAuthEntry[];
  total: number;
}

interface AvailableToken {
  id: string;
  idToken: string;
  tokenType: string;
  driverName: string | null;
}

interface StationLocalAuthListProps {
  stationId: string;
  isOnline: boolean;
  timezone: string;
}

export function StationLocalAuthList({
  stationId,
  isOnline,
  timezone,
}: StationLocalAuthListProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<LocalAuthEntry | null>(null);
  const [pushConfirmOpen, setPushConfirmOpen] = useState(false);
  const [tokenSearch, setTokenSearch] = useState('');
  const [selectedTokenIds, setSelectedTokenIds] = useState<Set<string>>(new Set());

  const limit = 10;

  const { data: listData } = useQuery({
    queryKey: ['local-auth-list', stationId, page],
    queryFn: () =>
      api.get<VersionInfo>(
        `/v1/stations/${stationId}/local-auth-list?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const entries = listData?.entries ?? [];
  const totalPages = Math.max(1, Math.ceil((listData?.total ?? 0) / limit));
  const localVersion = listData?.localVersion ?? 0;
  const lastSyncAt = listData?.lastSyncAt ?? null;
  const lastModifiedAt = listData?.lastModifiedAt ?? null;
  const hasUnpushedChanges =
    lastModifiedAt != null &&
    (lastSyncAt == null || new Date(lastModifiedAt) > new Date(lastSyncAt));

  const { data: availableTokensData } = useQuery({
    queryKey: ['local-auth-available-tokens', stationId, tokenSearch],
    queryFn: () =>
      api.get<{ data: AvailableToken[]; total: number }>(
        `/v1/stations/${stationId}/local-auth-list/available-tokens${tokenSearch !== '' ? `?search=${encodeURIComponent(tokenSearch)}` : ''}`,
      ),
    enabled: addOpen,
  });

  const availableTokens = availableTokensData?.data ?? [];

  const pushMutation = useMutation({
    mutationFn: () =>
      api.post<{ status: string; entriesCount: number; version: number }>(
        `/v1/stations/${stationId}/local-auth-list/push`,
        {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['local-auth-list', stationId] });
      setPushConfirmOpen(false);
      toast({ title: t('stations.syncSuccess'), variant: 'success' });
    },
    onError: (err: Error) => {
      setPushConfirmOpen(false);
      const message =
        err instanceof ApiError && err.body != null
          ? ((err.body as { error?: string }).error ?? err.message)
          : err.message;
      toast({ title: message, variant: 'destructive' });
    },
  });

  const addMutation = useMutation({
    mutationFn: (tokenIds: string[]) =>
      api.post<{ status: string; count: number }>(`/v1/stations/${stationId}/local-auth-list/add`, {
        tokenIds,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['local-auth-list', stationId] });
      void queryClient.invalidateQueries({
        queryKey: ['local-auth-available-tokens', stationId],
      });
      setAddOpen(false);
      setSelectedTokenIds(new Set());
      setTokenSearch('');
    },
  });

  const removeMutation = useMutation({
    mutationFn: (entryIds: number[]) =>
      api.post<{ status: string; count: number }>(
        `/v1/stations/${stationId}/local-auth-list/remove`,
        { entryIds },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['local-auth-list', stationId] });
      setRemoveTarget(null);
    },
  });

  function toggleToken(tokenId: string): void {
    setSelectedTokenIds((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) {
        next.delete(tokenId);
      } else {
        next.add(tokenId);
      }
      return next;
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <CardTitle>{t('stations.localAuthList')}</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!isOnline || pushMutation.isPending}
            onClick={() => {
              setPushConfirmOpen(true);
            }}
          >
            {pushMutation.isPending ? t('stations.pushing') : t('stations.pushToStation')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setSelectedTokenIds(new Set());
              setTokenSearch('');
              setAddOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t('stations.addTokens')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Version info bar */}
        <div className="flex flex-wrap items-center gap-4 mb-4 text-sm">
          <div>
            <span className="text-muted-foreground">{t('stations.csmsVersion')}:</span>{' '}
            <span className="font-medium">{String(localVersion)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('stations.lastSync')}:</span>{' '}
            <span className="font-medium">
              {lastSyncAt != null ? formatDateTime(lastSyncAt, timezone) : '--'}
            </span>
          </div>
        </div>

        {/* Unpushed changes banner */}
        {hasUnpushedChanges && (
          <div className="flex items-center rounded-md border border-warning/50 bg-warning/10 px-4 py-2 mb-4">
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <span>{t('stations.unpushedChanges')}</span>
            </div>
          </div>
        )}

        {/* Entries table */}
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stations.noLocalAuthEntries')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('stations.tokenColumn')}</TableHead>
                    <TableHead>{t('stations.typeColumn')}</TableHead>
                    <TableHead>{t('stations.driverColumn')}</TableHead>
                    <TableHead>{t('stations.authStatusColumn')}</TableHead>
                    <TableHead>{t('stations.addedAtColumn')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-xs">{entry.idToken}</TableCell>
                      <TableCell>{entry.tokenType}</TableCell>
                      <TableCell>{entry.driverName ?? '--'}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Badge variant={entry.authStatus === 'Accepted' ? 'default' : 'outline'}>
                            {entry.authStatus}
                          </Badge>
                          {entry.pushedAt == null && (
                            <Badge variant="warning">{t('stations.pending')}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{formatDateTime(entry.addedAt, timezone)}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('stations.removeEntry')}
                          disabled={removeMutation.isPending}
                          onClick={() => {
                            setRemoveTarget(entry);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-4">
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          </>
        )}
      </CardContent>

      {/* Push Confirm Dialog */}
      <ConfirmDialog
        open={pushConfirmOpen}
        onOpenChange={setPushConfirmOpen}
        title={t('stations.pushToStation')}
        description={t('stations.confirmPushToStation')}
        confirmLabel={t('stations.pushToStation')}
        variant="default"
        onConfirm={() => {
          pushMutation.mutate();
        }}
      >
        {localVersion === 0 && (
          <div className="flex items-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-4 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            <span>{t('stations.pushVersionZeroWarning')}</span>
          </div>
        )}
      </ConfirmDialog>

      {/* Remove Confirm Dialog */}
      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={t('stations.removeEntry')}
        description={t('stations.confirmRemoveEntry')}
        confirmLabel={t('stations.removeEntry')}
        onConfirm={() => {
          if (removeTarget != null) {
            removeMutation.mutate([removeTarget.id]);
          }
        }}
      />

      {/* Add Tokens Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('stations.addTokens')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={tokenSearch}
                onChange={(e) => {
                  setTokenSearch(e.target.value);
                }}
                placeholder={t('stations.searchTokens')}
                className="pl-9"
              />
            </div>
            <div className="max-h-[300px] overflow-y-auto border rounded-md">
              {availableTokens.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4">
                  {t('stations.noAvailableTokens')}
                </p>
              ) : (
                availableTokens.map((token) => (
                  <label
                    key={token.id}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-accent cursor-pointer border-b last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTokenIds.has(token.id)}
                      onChange={() => {
                        toggleToken(token.id);
                      }}
                      className="h-4 w-4 rounded border-input"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{token.idToken}</div>
                      <div className="text-xs text-muted-foreground">
                        {token.tokenType}
                        {token.driverName != null ? ` - ${token.driverName}` : ''}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
            {selectedTokenIds.size > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('stations.selectedCount', { count: selectedTokenIds.size })}
              </p>
            )}
          </div>
          <DialogFooter>
            <CancelButton
              onClick={() => {
                setAddOpen(false);
              }}
            />
            <Button
              disabled={selectedTokenIds.size === 0 || addMutation.isPending}
              onClick={() => {
                addMutation.mutate(Array.from(selectedTokenIds));
              }}
            >
              {addMutation.isPending ? t('stations.adding') : t('stations.addTokens')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
