// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TemplateEditor } from '@/components/TemplateEditor';
import { api } from '@/lib/api';
import type { TemplateVariable } from '@/lib/template-variables';

interface NotificationTemplate {
  eventType: string;
  channel: string;
  language: string;
  subject: string | null;
  bodyHtml: string | null;
  isCustomized: boolean;
}

interface PreviewResponse {
  subject: string | null;
  bodyHtml: string | null;
}

interface TemplateEditPanelProps {
  eventType: string;
  channel: 'email' | 'sms' | 'webhook';
  language: string;
  variables: TemplateVariable[];
  onSave?: (() => void | Promise<void>) | undefined;
  markDirty?: (() => void) | undefined;
  onStatusChange?: (status: { success: string; error: string }) => void;
  disabled?: boolean;
}

export interface TemplateEditPanelHandle {
  save: () => void;
  reset: () => void;
  preview: () => void;
  isSaving: boolean;
  isPending: boolean;
  isPreviewPending: boolean;
}

export const TemplateEditPanel = forwardRef<TemplateEditPanelHandle, TemplateEditPanelProps>(
  function TemplateEditPanel(
    {
      eventType,
      channel,
      language,
      variables,
      onSave,
      markDirty,
      onStatusChange,
      disabled = false,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();

    const [subject, setSubject] = useState('');
    const [bodyText, setBodyText] = useState('');
    const [bodyHtml, setBodyHtml] = useState('');
    const [previewOpen, setPreviewOpen] = useState(false);
    const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

    const templateQueryKey = ['notification-template', eventType, channel, language];

    const { data: template, isLoading } = useQuery({
      queryKey: templateQueryKey,
      queryFn: () =>
        api.get<NotificationTemplate>(
          `/v1/notification-templates?eventType=${encodeURIComponent(eventType)}&channel=${encodeURIComponent(channel)}&language=${encodeURIComponent(language)}`,
        ),
      enabled: eventType !== '',
    });

    const [loadedKey, setLoadedKey] = useState('');
    const currentKey = `${eventType}:${channel}:${language}`;
    if (template != null && currentKey !== loadedKey) {
      setSubject(template.subject ?? '');
      setBodyHtml(template.bodyHtml ?? '');
      setBodyText(channel !== 'email' ? (template.bodyHtml ?? '') : '');
      setLoadedKey(currentKey);
      onStatusChange?.({ success: '', error: '' });
    }

    const saveMutation = useMutation({
      mutationFn: async () => {
        // Validate and save settings (recipient/webhook URL) first
        if (onSave != null) {
          await onSave();
        }
        await api.put('/v1/notification-templates', {
          eventType,
          channel,
          language,
          subject: channel === 'email' ? subject : null,
          bodyHtml: channel === 'email' ? bodyHtml : bodyText,
        });
      },
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: templateQueryKey });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : t('notifications.templateSaveFailed');
        onStatusChange?.({ success: '', error: msg });
      },
    });

    const resetMutation = useMutation({
      mutationFn: () =>
        api.delete(
          `/v1/notification-templates?eventType=${encodeURIComponent(eventType)}&channel=${encodeURIComponent(channel)}&language=${encodeURIComponent(language)}`,
        ),
      onSuccess: async () => {
        await queryClient.refetchQueries({ queryKey: templateQueryKey });
        setLoadedKey('');
        onStatusChange?.({ success: t('notifications.templateReset'), error: '' });
      },
      onError: () => {
        onStatusChange?.({ success: '', error: t('notifications.templateSaveFailed') });
      },
    });

    const previewMutation = useMutation({
      mutationFn: () =>
        api.post<PreviewResponse>('/v1/notification-templates/preview', {
          eventType,
          channel,
          language,
          subject: channel === 'email' ? subject : null,
          bodyHtml: channel === 'email' ? bodyHtml : bodyText,
        }),
      onSuccess: () => {
        setPreviewOpen(true);
      },
    });

    const isPending = saveMutation.isPending || resetMutation.isPending;

    useImperativeHandle(
      ref,
      () => ({
        save() {
          saveMutation.mutate();
        },
        reset() {
          setResetConfirmOpen(true);
        },
        preview() {
          previewMutation.mutate();
        },
        get isSaving() {
          return saveMutation.isPending;
        },
        get isPending() {
          return isPending;
        },
        get isPreviewPending() {
          return previewMutation.isPending;
        },
      }),
      [saveMutation, previewMutation, isPending],
    );

    if (isLoading) {
      return (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            {t('common.loading')}
          </CardContent>
        </Card>
      );
    }

    return (
      <div className="space-y-4">
        <Card className={disabled ? 'opacity-50 pointer-events-none' : ''}>
          <CardContent className="p-6">
            <TemplateEditor
              channel={channel}
              subject={subject}
              onSubjectChange={(v) => {
                setSubject(v);
                markDirty?.();
              }}
              bodyText={bodyText}
              onBodyTextChange={(v) => {
                setBodyText(v);
                markDirty?.();
              }}
              bodyHtml={bodyHtml}
              onBodyHtmlChange={(v) => {
                setBodyHtml(v);
                markDirty?.();
              }}
              variables={variables}
            />
          </CardContent>
        </Card>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t('notifications.preview')}</DialogTitle>
            </DialogHeader>
            {previewMutation.isSuccess && (
              <div className="space-y-4">
                {previewMutation.data.subject != null && (
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {t('notifications.subject')}
                    </Label>
                    <p className="text-sm mt-1">{previewMutation.data.subject}</p>
                  </div>
                )}
                {previewMutation.data.bodyHtml != null && (
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {t('notifications.templateBody')}
                    </Label>
                    {channel === 'email' ? (
                      <iframe
                        title="HTML Preview"
                        srcDoc={previewMutation.data.bodyHtml}
                        className="w-full min-h-[250px] md:min-h-[400px] bg-white border rounded-md mt-1"
                        sandbox=""
                      />
                    ) : (
                      <pre className="text-sm whitespace-pre-wrap bg-muted p-3 rounded-md mt-1">
                        {previewMutation.data.bodyHtml}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={resetConfirmOpen}
          onOpenChange={setResetConfirmOpen}
          title={t('notifications.resetToDefault')}
          description={t('notifications.resetConfirmMessage')}
          confirmLabel={t('notifications.resetToDefault')}
          onConfirm={() => {
            resetMutation.mutate();
          }}
        />
      </div>
    );
  },
);
