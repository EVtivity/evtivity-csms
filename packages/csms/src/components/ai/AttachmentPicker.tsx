// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatFileSize } from '@/lib/formatting';
import { cn } from '@/lib/utils';
import {
  AI_ATTACHMENT_ACCEPT,
  AI_ATTACHMENT_MAX_BYTES,
  AI_ATTACHMENT_MAX_PER_MESSAGE,
  AI_ATTACHMENT_TYPES,
  attachmentMimeType,
  checkAttachment,
} from './ai-attachments';
import type { AttachmentRejection } from './ai-attachments';

export interface PendingAttachment {
  localId: string;
  file: File;
  /** Object URL of the user's own image, for the thumbnail. */
  previewUrl: string | null;
  /** `uploading` until the server confirmed (sniffed and sanitized) the file. */
  status: 'uploading' | 'ready' | 'error';
  /** Set once the upload is confirmed; the message sends it in `attachmentIds`. */
  attachmentId: string | null;
  kind: 'image' | 'document';
  /** Translation key of the per-file error. */
  error:
    | 'ai.attachmentErrors.typeNotAllowed'
    | 'ai.attachmentErrors.tooLarge'
    | 'ai.attachmentErrors.tooMany'
    | 'ai.attachmentErrors.uploadFailed'
    | null;
  /** API error code when the server refused the file. */
  errorCode: string | null;
}

const REJECTION_KEYS: Record<AttachmentRejection, NonNullable<PendingAttachment['error']>> = {
  typeNotAllowed: 'ai.attachmentErrors.typeNotAllowed',
  tooLarge: 'ai.attachmentErrors.tooLarge',
  tooMany: 'ai.attachmentErrors.tooMany',
};

let counter = 0;

/**
 * Adds files to the pending list; files that fail the checks are kept with
 * their error. Accepted files start as `uploading`: the caller uploads them.
 */
export function addPendingFiles(current: PendingAttachment[], files: File[]): PendingAttachment[] {
  const next = [...current];
  for (const file of files) {
    const accepted = next.filter((a) => a.error == null).length;
    const rejection = checkAttachment(file, accepted);
    counter += 1;
    const isImage = AI_ATTACHMENT_TYPES[attachmentMimeType(file) ?? ''] === 'image';
    next.push({
      localId: `att-${String(counter)}`,
      file,
      previewUrl: rejection == null && isImage ? URL.createObjectURL(file) : null,
      status: rejection == null ? 'uploading' : 'error',
      attachmentId: null,
      kind: isImage ? 'image' : 'document',
      error: rejection == null ? null : REJECTION_KEYS[rejection],
      errorCode: null,
    });
  }
  return next;
}

export function releasePreview(att: PendingAttachment): void {
  if (att.previewUrl != null) URL.revokeObjectURL(att.previewUrl);
}

interface AttachmentPickerButtonProps {
  disabled: boolean;
  onFiles: (files: File[]) => void;
}

/** The paperclip button that opens the file chooser. */
export function AttachmentPickerButton({
  disabled,
  onFiles,
}: AttachmentPickerButtonProps): React.JSX.Element {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={AI_ATTACHMENT_ACCEPT}
        className="hidden"
        data-testid="ai-file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={t('ai.attach')}
        title={t('ai.attachHint', {
          size: formatFileSize(AI_ATTACHMENT_MAX_BYTES),
          max: AI_ATTACHMENT_MAX_PER_MESSAGE,
        })}
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        <Paperclip className="h-4 w-4" />
      </Button>
    </>
  );
}

interface AttachmentPreviewsProps {
  attachments: PendingAttachment[];
  onRemove: (localId: string) => void;
  disabled: boolean;
}

/** Thumbnails and chips of the files queued for the next message. */
export function AttachmentPreviews({
  attachments,
  onRemove,
  disabled,
}: AttachmentPreviewsProps): React.JSX.Element | null {
  const { t } = useTranslation();
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label={t('ai.attachments')}>
      {attachments.map((att) => (
        <li
          key={att.localId}
          className={cn(
            'relative flex max-w-[12rem] items-center gap-2 rounded-md border bg-background p-1.5 pr-7 text-xs',
            att.error != null ? 'border-destructive' : 'border-border',
          )}
        >
          {att.previewUrl != null ? (
            <img
              src={att.previewUrl}
              alt={att.file.name}
              className="h-10 w-10 shrink-0 rounded object-cover"
            />
          ) : (
            <FileText className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <p className="truncate font-medium" title={att.file.name}>
              {att.file.name}
            </p>
            {att.error != null ? (
              <p className="text-destructive">
                {att.errorCode != null
                  ? t(`errors.${att.errorCode}`, {
                      defaultValue: t(att.error),
                    })
                  : t(att.error)}
              </p>
            ) : (
              <p className="text-muted-foreground">{formatFileSize(att.file.size)}</p>
            )}
          </div>
          {att.status === 'uploading' ? (
            <Spinner className="absolute right-1.5 top-1.5 h-3.5 w-3.5" />
          ) : (
            <button
              type="button"
              disabled={disabled}
              aria-label={t('ai.removeAttachment', { name: att.file.name })}
              onClick={() => {
                onRemove(att.localId);
              }}
              className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Revokes every preview URL when the owner unmounts. */
export function useReleasePreviews(attachments: PendingAttachment[]): void {
  const ref = useRef(attachments);
  useEffect(() => {
    ref.current = attachments;
  }, [attachments]);
  useEffect(
    () => () => {
      ref.current.forEach(releasePreview);
    },
    [],
  );
}
