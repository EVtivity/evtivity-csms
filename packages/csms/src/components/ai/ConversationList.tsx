// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, MessageSquare, Pencil, Plus, Trash2, X } from 'lucide-react';
import { SearchInput } from '@/components/search-input';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { cn } from '@/lib/utils';

export interface AiConversationItem {
  id: string;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export const AI_CONVERSATIONS_KEY = ['ai-conversations'] as const;

interface ConversationListProps {
  activeId: string | null;
  canWrite: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Called after the active conversation was deleted. */
  onDeleted: (id: string) => void;
}

/** The user's conversations: open, rename, delete and search. */
export function ConversationList({
  activeId,
  canWrite,
  onOpen,
  onNew,
  onDeleted,
}: ConversationListProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const timezone = useUserTimezone();
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<AiConversationItem | null>(null);

  const list = useQuery({
    queryKey: [...AI_CONVERSATIONS_KEY, search],
    queryFn: () =>
      api.get<{ data: AiConversationItem[]; total: number }>(
        `/v1/assistant/conversations?limit=50${search !== '' ? `&search=${encodeURIComponent(search)}` : ''}`,
      ),
    staleTime: 30_000,
  });

  const rename = useMutation({
    mutationFn: (vals: { id: string; title: string }) =>
      api.patch<AiConversationItem>(`/v1/assistant/conversations/${encodeURIComponent(vals.id)}`, {
        title: vals.title,
      }),
    onSuccess: () => {
      setRenamingId(null);
      void queryClient.invalidateQueries({ queryKey: AI_CONVERSATIONS_KEY });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/assistant/conversations/${encodeURIComponent(id)}`),
    onSuccess: (_data, id) => {
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: AI_CONVERSATIONS_KEY });
      onDeleted(id);
    },
  });

  function submitRename(id: string): void {
    const title = renameValue.trim();
    if (title === '') return;
    rename.mutate({ id, title });
  }

  const items = list.data?.data ?? [];

  return (
    <div className="flex h-full flex-col gap-3 p-3" data-testid="ai-conversation-list">
      <div className="flex items-center gap-2">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('ai.searchConversations')}
          size="sm"
          className="max-w-none flex-1"
        />
        {canWrite && (
          <Button type="button" size="sm" onClick={onNew}>
            <Plus className="h-4 w-4" />
            <span className="ml-1">{t('ai.newChat')}</span>
          </Button>
        )}
      </div>
      {rename.isError && (
        <p className="text-xs text-destructive">
          {getErrorMessage(rename.error, t, 'ai.renameFailed')}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isLoading && (
          <div className="flex justify-center p-4">
            <Spinner className="h-5 w-5" />
          </div>
        )}
        {list.isError && (
          <p className="p-2 text-sm text-destructive">
            {getErrorMessage(list.error, t, 'ai.loadFailed')}
          </p>
        )}
        {list.isSuccess && items.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">
            {search !== '' ? t('ai.noConversationsMatch') : t('ai.noConversations')}
          </p>
        )}
        <ul className="space-y-1">
          {items.map((c) => (
            <li
              key={c.id}
              className={cn(
                'group flex items-center gap-1 rounded-md pr-1',
                c.id === activeId ? 'bg-muted' : 'hover:bg-muted/60',
              )}
            >
              {renamingId === c.id ? (
                <form
                  className="flex flex-1 items-center gap-1 p-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitRename(c.id);
                  }}
                >
                  <Input
                    autoFocus
                    value={renameValue}
                    maxLength={200}
                    aria-label={t('ai.renameLabel')}
                    className="h-8"
                    onChange={(e) => {
                      setRenameValue(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setRenamingId(null);
                      }
                    }}
                  />
                  <Button
                    type="submit"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={t('common.save')}
                    disabled={rename.isPending || renameValue.trim() === ''}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={t('common.cancel')}
                    onClick={() => {
                      setRenamingId(null);
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      onOpen(c.id);
                    }}
                    aria-current={c.id === activeId ? 'true' : undefined}
                    className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <MessageSquare
                      className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm">
                        {c.title !== '' ? c.title : t('ai.untitled')}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(c.updatedAt, timezone)}
                      </span>
                    </span>
                  </button>
                  {canWrite && (
                    <div className="flex shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={t('ai.renameConversation', {
                          title: c.title !== '' ? c.title : t('ai.untitled'),
                        })}
                        onClick={() => {
                          setRenamingId(c.id);
                          setRenameValue(c.title);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={t('ai.deleteConversation', {
                          title: c.title !== '' ? c.title : t('ai.untitled'),
                        })}
                        onClick={() => {
                          setDeleting(c);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
      <ConfirmDialog
        open={deleting != null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('ai.deleteTitle')}
        description={t('ai.deleteDescription', {
          title: deleting != null && deleting.title !== '' ? deleting.title : t('ai.untitled'),
        })}
        confirmLabel={t('common.delete')}
        isPending={remove.isPending}
        onConfirm={() => {
          if (deleting != null) remove.mutate(deleting.id);
          return false;
        }}
      >
        {remove.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(remove.error, t, 'ai.deleteFailed')}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
