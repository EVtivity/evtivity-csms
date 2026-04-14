// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Trash2, Plus, Loader2, ImageIcon, X, Star } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Toggle } from '@/components/ui/toggle';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { FileViewerDialog, type ViewerFile } from '@/components/FileViewerDialog';
import { api } from '@/lib/api';

interface StationImage {
  id: number;
  stationId: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  s3Key: string;
  s3Bucket: string;
  caption: string | null;
  tags: string[];
  isDriverVisible: boolean;
  isMainImage: boolean;
  sortOrder: number;
  uploadedBy: string | null;
  createdAt: string;
}

interface StationImagesProps {
  stationId: string;
}

export function StationImages({ stationId }: StationImagesProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mainImageUrl, setMainImageUrl] = useState<string | null>(null);
  const [mainImageLoading, setMainImageLoading] = useState(false);
  const [thumbnailUrls, setThumbnailUrls] = useState<Map<number, string>>(new Map());
  const [viewerOpen, setViewerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<StationImage | null>(null);
  const [driverVisiblePending, setDriverVisiblePending] = useState<boolean | null>(null);
  const [captionValue, setCaptionValue] = useState('');
  const [newTag, setNewTag] = useState('');

  const queryKey = ['stations', stationId, 'images'];

  const { data: images = [] } = useQuery({
    queryKey,
    queryFn: () => api.get<StationImage[]>(`/v1/stations/${stationId}/images`),
  });

  const selectedImage = images[selectedIndex] ?? null;

  // Fetch main image URL when selected index changes
  useEffect(() => {
    if (selectedImage == null) {
      setMainImageUrl(null);
      return;
    }
    setMainImageLoading(true);
    setMainImageUrl(null);
    api
      .get<{ downloadUrl: string }>(
        `/v1/stations/${stationId}/images/${String(selectedImage.id)}/download-url`,
      )
      .then(({ downloadUrl }) => {
        setMainImageUrl(downloadUrl);
      })
      .catch(() => {
        setMainImageUrl(null);
      })
      .finally(() => {
        setMainImageLoading(false);
      });
  }, [selectedImage?.id, stationId]);

  // Sync caption value when selected image changes
  useEffect(() => {
    setCaptionValue(selectedImage?.caption ?? '');
  }, [selectedImage?.id, selectedImage?.caption]);

  // Fetch thumbnail URLs lazily
  useEffect(() => {
    for (const image of images) {
      if (thumbnailUrls.has(image.id)) continue;
      api
        .get<{ downloadUrl: string }>(
          `/v1/stations/${stationId}/images/${String(image.id)}/download-url`,
        )
        .then(({ downloadUrl }) => {
          setThumbnailUrls((prev) => {
            const next = new Map(prev);
            next.set(image.id, downloadUrl);
            return next;
          });
        })
        .catch(() => {});
    }
  }, [images, stationId, thumbnailUrls]);

  // Keep selectedIndex in bounds
  useEffect(() => {
    if (images.length > 0 && selectedIndex >= images.length) {
      setSelectedIndex(images.length - 1);
    }
  }, [images.length, selectedIndex]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
    setThumbnailUrls(new Map());
  }, [queryClient, queryKey]);

  const updateMutation = useMutation({
    mutationFn: ({ imageId, body }: { imageId: number; body: Record<string, unknown> }) =>
      api.patch(`/v1/stations/${stationId}/images/${String(imageId)}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (imageId: number) =>
      api.delete(`/v1/stations/${stationId}/images/${String(imageId)}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
  });

  const setMainMutation = useMutation({
    mutationFn: (imageId: number) =>
      api.post(`/v1/stations/${stationId}/images/${String(imageId)}/set-main`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  async function handleUpload(files: FileList): Promise<void> {
    setUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file == null) continue;
        setUploadProgress({ current: i + 1, total: files.length });

        const { uploadUrl, s3Key, s3Bucket } = await api.post<{
          uploadUrl: string;
          s3Key: string;
          s3Bucket: string;
        }>(`/v1/stations/${stationId}/images/upload-url`, {
          fileName: file.name,
          contentType: file.type || 'image/jpeg',
          fileSize: file.size,
        });

        const uploadRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'image/jpeg' },
          body: file,
        });
        if (!uploadRes.ok) {
          throw new Error(`Upload failed: ${String(uploadRes.status)}`);
        }

        await api.post(`/v1/stations/${stationId}/images`, {
          fileName: file.name,
          fileSize: file.size,
          contentType: file.type || 'image/jpeg',
          s3Key,
          s3Bucket,
        });
      }
      invalidate();
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : 'Upload failed',
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileInputRef.current != null) {
        fileInputRef.current.value = '';
      }
    }
  }

  function handleCaptionBlur(): void {
    if (selectedImage == null) return;
    const trimmed = captionValue.trim();
    const current = selectedImage.caption ?? '';
    if (trimmed === current) return;
    updateMutation.mutate({
      imageId: selectedImage.id,
      body: { caption: trimmed === '' ? null : trimmed },
    });
  }

  function handleAddTag(): void {
    if (selectedImage == null) return;
    const tag = newTag.trim();
    if (tag === '' || selectedImage.tags.includes(tag)) {
      setNewTag('');
      return;
    }
    const updatedTags = [...selectedImage.tags, tag];
    updateMutation.mutate({ imageId: selectedImage.id, body: { tags: updatedTags } });
    setNewTag('');
  }

  function handleRemoveTag(tag: string): void {
    if (selectedImage == null) return;
    const updatedTags = selectedImage.tags.filter((t) => t !== tag);
    updateMutation.mutate({ imageId: selectedImage.id, body: { tags: updatedTags } });
  }

  function handleToggleDriverVisible(checked: boolean): void {
    if (selectedImage == null) return;
    setDriverVisiblePending(checked);
  }

  function confirmDriverVisible(): void {
    if (selectedImage == null || driverVisiblePending == null) return;
    updateMutation.mutate({
      imageId: selectedImage.id,
      body: { isDriverVisible: driverVisiblePending },
    });
    setDriverVisiblePending(null);
  }

  function handleSetMain(): void {
    if (selectedImage == null) return;
    setMainMutation.mutate(selectedImage.id);
  }

  const getDownloadUrl = useCallback(
    async (file: ViewerFile): Promise<string | null> => {
      try {
        const { downloadUrl } = await api.get<{ downloadUrl: string }>(
          `/v1/stations/${stationId}/images/${String(file.id)}/download-url`,
        );
        return downloadUrl;
      } catch {
        return null;
      }
    },
    [stationId],
  );

  const viewerFiles: ViewerFile[] = images.map((img) => ({
    id: img.id,
    fileName: img.fileName,
    fileSize: img.fileSize,
    contentType: img.contentType,
  }));

  // Empty state
  if (images.length === 0 && !uploading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('stations.images')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border py-12 gap-4">
            <ImageIcon className="h-12 w-12 text-muted-foreground" />
            <div className="text-center">
              <p className="text-sm font-medium">{t('stations.noImages')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('stations.noImagesDescription')}
              </p>
            </div>
            <Button
              onClick={() => {
                fileInputRef.current?.click();
              }}
            >
              <Plus className="h-4 w-4" />
              {t('stations.uploadImages')}
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files != null && e.target.files.length > 0) {
                void handleUpload(e.target.files);
              }
            }}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <CardTitle>{t('stations.images')}</CardTitle>
        <div className="flex items-center gap-2">
          {uploading && uploadProgress != null && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('stations.uploading', {
                current: uploadProgress.current,
                total: uploadProgress.total,
              })}
            </div>
          )}
          <Button
            disabled={uploading}
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            <Plus className="h-4 w-4" />
            {t('stations.uploadImages')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6">
        {/* Carousel area */}
        <div className="grid gap-4">
          {/* Main image */}
          <div className="relative flex items-center justify-center min-h-[300px] rounded-lg bg-muted">
            {mainImageLoading ? (
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            ) : mainImageUrl != null ? (
              <button
                type="button"
                className="w-full"
                onClick={() => {
                  setViewerOpen(true);
                }}
              >
                <img
                  src={mainImageUrl}
                  alt={selectedImage?.fileName ?? ''}
                  className="max-h-[300px] md:max-h-[400px] w-full object-contain rounded-lg cursor-pointer"
                />
              </button>
            ) : (
              <ImageIcon className="h-12 w-12 text-muted-foreground" />
            )}

            {/* Navigation arrows */}
            {images.length > 1 && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background"
                  disabled={selectedIndex === 0}
                  onClick={() => {
                    setSelectedIndex((i) => i - 1);
                  }}
                  aria-label={t('common.prev')}
                >
                  <ChevronLeft className="h-5 w-5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background"
                  disabled={selectedIndex === images.length - 1}
                  onClick={() => {
                    setSelectedIndex((i) => i + 1);
                  }}
                  aria-label={t('common.next')}
                >
                  <ChevronRight className="h-5 w-5" />
                </Button>
              </>
            )}
          </div>

          {/* Thumbnail strip */}
          {images.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {images.map((image, index) => (
                <button
                  key={image.id}
                  type="button"
                  className={`shrink-0 h-16 w-16 rounded-md overflow-hidden border-2 transition-colors ${
                    index === selectedIndex
                      ? 'ring-2 ring-primary border-primary'
                      : 'border-transparent hover:border-border'
                  }`}
                  onClick={() => {
                    setSelectedIndex(index);
                  }}
                >
                  {thumbnailUrls.has(image.id) ? (
                    <img
                      src={thumbnailUrls.get(image.id)}
                      alt={image.fileName}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center bg-muted">
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Metadata panel */}
        {selectedImage != null && (
          <div className="grid gap-4">
            {/* Caption */}
            <div className="grid gap-2">
              <Label htmlFor="img-caption">{t('stations.caption')}</Label>
              <Input
                id="img-caption"
                value={captionValue}
                onChange={(e) => {
                  setCaptionValue(e.target.value);
                }}
                onBlur={handleCaptionBlur}
                placeholder={t('stations.captionPlaceholder')}
              />
            </div>

            {/* Tags */}
            <div className="grid gap-2">
              <Label htmlFor="img-tags">{t('stations.tags')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {selectedImage.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    {tag}
                    <button
                      type="button"
                      onClick={() => {
                        handleRemoveTag(tag);
                      }}
                      className="ml-0.5 hover:text-destructive"
                      aria-label={`Remove ${tag}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <Input
                id="img-tags"
                value={newTag}
                onChange={(e) => {
                  setNewTag(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTag();
                  }
                }}
                placeholder={t('stations.tagPlaceholder')}
              />
            </div>

            {/* Driver visible toggle */}
            <div className="flex items-center gap-3">
              <Toggle
                checked={selectedImage.isDriverVisible}
                onCheckedChange={handleToggleDriverVisible}
              />
              <Label>{t('stations.driverVisible')}</Label>
            </div>

            {/* Main image + Delete */}
            <div className="flex items-center gap-2">
              {selectedImage.isMainImage ? (
                <Badge variant="default" className="gap-1">
                  <Star className="h-3 w-3" />
                  {t('stations.mainImage')}
                </Badge>
              ) : (
                <Button variant="outline" size="sm" onClick={handleSetMain}>
                  <Star className="h-4 w-4" />
                  {t('stations.setAsMain')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto text-destructive hover:text-destructive"
                onClick={() => {
                  setDeleteTarget(selectedImage);
                }}
                aria-label={t('stations.deleteImage')}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files != null && e.target.files.length > 0) {
            void handleUpload(e.target.files);
          }
        }}
      />

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('stations.deleteImage')}
        description={t('stations.confirmDeleteImage')}
        confirmLabel={t('stations.deleteImage')}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget != null) {
            deleteMutation.mutate(deleteTarget.id);
          }
        }}
      />

      {/* Driver visible confirm dialog */}
      <ConfirmDialog
        open={driverVisiblePending != null}
        onOpenChange={(open) => {
          if (!open) setDriverVisiblePending(null);
        }}
        title={t('stations.driverVisible')}
        description={
          driverVisiblePending === true
            ? t('stations.confirmDriverVisibleOn')
            : t('stations.confirmDriverVisibleOff')
        }
        confirmLabel={t('common.confirm')}
        onConfirm={confirmDriverVisible}
      />

      {/* File viewer dialog */}
      {viewerOpen && (
        <FileViewerDialog
          files={viewerFiles}
          currentIndex={selectedIndex}
          onClose={() => {
            setViewerOpen(false);
          }}
          onNavigate={(index) => {
            setSelectedIndex(index);
          }}
          getDownloadUrl={getDownloadUrl}
        />
      )}
    </Card>
  );
}
