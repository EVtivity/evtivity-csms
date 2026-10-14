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
      status: rejection == null ? 'uploading' : 'error',
      attachmentId: null,
      kind: isImage ? 'image' : 'document',
      error: rejection == null ? null : REJECTION_KEYS[rejection],
      errorCode: null,
    });
  }
  return next;
}

const THUMBNAIL_PX = 40;

/**
 * The thumbnail of the user's own image, drawn on a canvas from the decoded
 * pixels. The file never becomes a URL in the page (an object URL of a
 * user-chosen file is same-origin content), and nothing needs revoking.
 */
function ImageThumbnail({ file }: { file: File }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    // Not every runtime decodes images (test DOMs): the canvas stays blank.
    if (typeof createImageBitmap !== 'function') return;
    let cancelled = false;
    createImageBitmap(file)
      .then((bitmap) => {
        const canvas = canvasRef.current;
        const ctx = cancelled || canvas == null ? null : canvas.getContext('2d');
        if (ctx != null && canvas != null) {
          // Cover: the centered square of the image, scaled to the canvas.
          const side = Math.min(bitmap.width, bitmap.height);
          const scale = window.devicePixelRatio > 1 ? 2 : 1;
          canvas.width = THUMBNAIL_PX * scale;
          canvas.height = THUMBNAIL_PX * scale;
          ctx.drawImage(
            bitmap,
            (bitmap.width - side) / 2,
            (bitmap.height - side) / 2,
            side,
            side,
            0,
            0,
            canvas.width,
            canvas.height,
          );
        }
        bitmap.close();
      })
      .catch((err: unknown) => {
        // The server sniffs and refuses a file that is not an image; the chip
        // keeps its name and size without a thumbnail.
        console.warn('Decoding an attachment thumbnail failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={file.name}
      width={THUMBNAIL_PX}
      height={THUMBNAIL_PX}
      className="h-10 w-10 shrink-0 rounded bg-muted"
    />
  );
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
          {att.kind === 'image' && att.error == null ? (
            <ImageThumbnail file={att.file} />
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
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label={t('ai.removeAttachment', { name: att.file.name })}
              onClick={() => {
                onRemove(att.localId);
              }}
              className="absolute right-1 top-1"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
