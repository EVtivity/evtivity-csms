// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, FileText, Paperclip, Trash2 } from 'lucide-react';
import {
  FileViewerDialog,
  IMAGE_CONTENT_TYPES,
  formatFileSize,
} from '@/components/FileViewerDialog';
import type { ViewerFile } from '@/components/FileViewerDialog';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getErrorMessage } from '@/lib/error-message';
import { api } from '@/lib/api';

interface Attachment {
  id: number;
  messageId: number;
  fileName: string;
  fileSize: number;
  contentType: string;
  createdAt: string;
}

interface Message {
  id: number;
  senderType: 'driver' | 'operator' | 'system';
  senderId: string | null;
  body: string;
  isInternal: boolean;
  createdAt: string;
  attachments: Attachment[];
}

interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

interface CaseDetail {
  id: string;
  status: string;
  priority: string;
  category: string;
  assignedTo: string | null;
  messages: Message[];
}

const STATUS_OPTIONS = ['open', 'in_progress', 'waiting_on_driver', 'resolved', 'closed'] as const;
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'] as const;
const CATEGORY_OPTIONS = [
  'billing_dispute',
  'charging_failure',
  'connector_damage',
  'account_issue',
  'payment_problem',
  'reservation_issue',
  'general_inquiry',
] as const;

interface CaseInfoSidebarProps {
  caseDetail: CaseDetail;
  operatorUsers: User[] | undefined;
}

export function CaseInfoSidebar({
  caseDetail,
  operatorUsers,
}: CaseInfoSidebarProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [editStatus, setEditStatus] = useState('');
  const [editPriority, setEditPriority] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editAssignedTo, setEditAssignedTo] = useState('');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [deleteAttachment, setDeleteAttachment] = useState<Attachment | null>(null);

  useEffect(() => {
    setEditStatus(caseDetail.status);
    setEditPriority(caseDetail.priority);
    setEditCategory(caseDetail.category);
    setEditAssignedTo(caseDetail.assignedTo ?? '');
  }, [caseDetail]);

  const allAttachments = useMemo(() => {
    return caseDetail.messages.flatMap((msg) => msg.attachments);
  }, [caseDetail]);

  const getDownloadUrl = useCallback(
    async (file: ViewerFile): Promise<string | null> => {
      const att = allAttachments.find((a) => a.id === file.id);
      if (att == null) return null;
      try {
        const res = await api.get<{ downloadUrl: string }>(
          `/v1/support-cases/${caseDetail.id}/messages/${String(att.messageId)}/attachments/${String(att.id)}/download-url`,
        );
        return res.downloadUrl;
      } catch {
        return null;
      }
    },
    [allAttachments, caseDetail.id],
  );

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.patch(`/v1/support-cases/${caseDetail.id}`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['support-cases', caseDetail.id] });
      void queryClient.invalidateQueries({ queryKey: ['support-cases'] });
    },
  });

  const deleteAttachmentMutation = useMutation({
    mutationFn: (att: Attachment) =>
      api.delete(
        `/v1/support-cases/${caseDetail.id}/messages/${String(att.messageId)}/attachments/${String(att.id)}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['support-cases', caseDetail.id] });
      setDeleteAttachment(null);
    },
  });

  function handleSidebarUpdate(): void {
    const patch: Record<string, unknown> = {};
    if (editStatus !== caseDetail.status) patch.status = editStatus;
    if (editPriority !== caseDetail.priority) patch.priority = editPriority;
    if (editCategory !== caseDetail.category) patch.category = editCategory;
    if (editAssignedTo !== (caseDetail.assignedTo ?? '')) {
      patch.assignedTo = editAssignedTo === '' ? null : editAssignedTo;
    }
    if (Object.keys(patch).length > 0) {
      updateMutation.mutate(patch);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="case-status-select">{t('common.status')}</Label>
            <Select
              id="case-status-select"
              value={editStatus}
              onChange={(e) => {
                setEditStatus(e.target.value);
              }}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {t(`supportCases.statuses.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="case-priority-edit">{t('supportCases.priority')}</Label>
            <Select
              id="case-priority-edit"
              value={editPriority}
              onChange={(e) => {
                setEditPriority(e.target.value);
              }}
            >
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {t(`supportCases.priorities.${p}`)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="case-category-edit">{t('supportCases.category')}</Label>
            <Select
              id="case-category-edit"
              value={editCategory}
              onChange={(e) => {
                setEditCategory(e.target.value);
              }}
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {t(`supportCases.categories.${c}`)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="case-assigned-to-edit">{t('supportCases.assignedTo')}</Label>
            <Select
              id="case-assigned-to-edit"
              value={editAssignedTo}
              onChange={(e) => {
                setEditAssignedTo(e.target.value);
              }}
            >
              <option value="">-</option>
              {operatorUsers?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.firstName} {u.lastName}
                </option>
              ))}
            </Select>
          </div>

          <SaveButton
            isPending={updateMutation.isPending}
            type="button"
            onClick={handleSidebarUpdate}
          />

          {updateMutation.isError && (
            <p className="text-sm text-destructive">{getErrorMessage(updateMutation.error, t)}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">{t('supportCases.attachments')}</CardTitle>
            </div>
            {allAttachments.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {t('supportCases.attachmentCount', { count: allAttachments.length })}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {allAttachments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('supportCases.noAttachments')}</p>
          ) : (
            <div className="space-y-1">
              {allAttachments.map((att, idx) => (
                <div
                  key={att.id}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setViewerIndex(idx);
                    }}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                  >
                    {IMAGE_CONTENT_TYPES.has(att.contentType) ? (
                      <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate flex-1">{att.fileName}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteAttachment(att);
                    }}
                    className="shrink-0 p-0.5 text-muted-foreground hover:text-destructive"
                    aria-label={t('supportCases.deleteAttachment')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatFileSize(att.fileSize)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteAttachment != null}
        onOpenChange={(open) => {
          if (!open) setDeleteAttachment(null);
        }}
        title={t('supportCases.deleteAttachment')}
        description={t('supportCases.confirmDeleteAttachment')}
        confirmLabel={t('common.delete')}
        variant="destructive"
        onConfirm={() => {
          if (deleteAttachment != null) {
            deleteAttachmentMutation.mutate(deleteAttachment);
          }
          return true;
        }}
      />

      {viewerIndex != null && (
        <FileViewerDialog
          files={allAttachments}
          currentIndex={viewerIndex}
          onClose={() => {
            setViewerIndex(null);
          }}
          onNavigate={setViewerIndex}
          getDownloadUrl={getDownloadUrl}
        />
      )}
    </div>
  );
}
