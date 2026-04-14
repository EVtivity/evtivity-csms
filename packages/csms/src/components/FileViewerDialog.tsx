// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { formatFileSize } from '@/lib/formatting';

export { formatFileSize };

export const IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

export interface ViewerFile {
  id: number;
  fileName: string;
  fileSize: number;
  contentType: string;
}

interface FileViewerDialogProps {
  files: ViewerFile[];
  currentIndex: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
  getDownloadUrl: (file: ViewerFile) => Promise<string | null>;
}

export function FileViewerDialog({
  files,
  currentIndex,
  onClose,
  onNavigate,
  getDownloadUrl,
}: FileViewerDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const file = files[currentIndex];
  const isImage = file != null && IMAGE_CONTENT_TYPES.has(file.contentType);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < files.length - 1;

  useEffect(() => {
    if (file == null) return;
    setLoading(true);
    setDownloadUrl(null);

    getDownloadUrl(file)
      .then((url) => {
        setDownloadUrl(url);
      })
      .catch(() => {
        setDownloadUrl(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [file, getDownloadUrl]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) {
        onNavigate(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && hasNext) {
        onNavigate(currentIndex + 1);
      }
    },
    [currentIndex, hasPrev, hasNext, onNavigate],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  if (file == null) return <></>;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={isImage ? 'max-w-4xl' : 'max-w-lg'}>
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between pr-8">
            <span className="truncate">{file.fileName}</span>
            <span className="shrink-0 text-sm font-normal text-muted-foreground ml-2">
              {formatFileSize(file.fileSize)}
              {files.length > 1 && (
                <span className="ml-2">
                  {t('supportCases.ofCount', {
                    current: currentIndex + 1,
                    total: files.length,
                  })}
                </span>
              )}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-center min-h-[200px]">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : isImage && downloadUrl != null ? (
            <img
              src={downloadUrl}
              alt={file.fileName}
              className="max-h-[60vh] object-contain rounded-md"
            />
          ) : (
            <div className="flex flex-col items-center gap-4 py-8">
              <FileText className="h-12 w-12 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {t('supportCases.previewNotAvailable')}
              </p>
              {downloadUrl != null && (
                <Button
                  variant="outline"
                  onClick={() => {
                    window.open(downloadUrl, '_blank');
                  }}
                >
                  <Download className="h-4 w-4" />
                  {t('common.download')}
                </Button>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <div className="flex items-center gap-2 mr-auto">
            <Button
              variant="outline"
              size="icon"
              disabled={!hasPrev}
              onClick={() => {
                onNavigate(currentIndex - 1);
              }}
              aria-label={t('common.prev')}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              disabled={!hasNext}
              onClick={() => {
                onNavigate(currentIndex + 1);
              }}
              aria-label={t('common.next')}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {downloadUrl != null && (
            <Button
              variant="outline"
              onClick={() => {
                window.open(downloadUrl, '_blank');
              }}
            >
              <Download className="h-4 w-4" />
              {t('common.download')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
