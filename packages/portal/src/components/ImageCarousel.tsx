// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { api } from '@/lib/api';

interface ImageItem {
  id: number;
  stationId: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  caption: string | null;
}

interface ImageCarouselProps {
  siteId: string;
}

function ImageThumbnail({
  siteId,
  image,
  onClick,
}: {
  siteId: string;
  image: ImageItem;
  onClick: () => void;
}): React.JSX.Element {
  const { data } = useQuery({
    queryKey: ['location-image-url', siteId, image.id],
    queryFn: () =>
      api.get<{ downloadUrl: string }>(
        `/v1/portal/chargers/location/${siteId}/images/${String(image.id)}/download-url`,
      ),
    staleTime: 1000 * 60 * 50,
  });

  return (
    <button
      type="button"
      onClick={onClick}
      className="h-20 w-20 shrink-0 overflow-hidden rounded-md bg-muted transition-opacity hover:opacity-80"
    >
      {data?.downloadUrl != null ? (
        <img
          src={data.downloadUrl}
          alt={image.caption ?? image.fileName}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="h-full w-full animate-pulse bg-muted" />
      )}
    </button>
  );
}

function ImageOverlay({
  siteId,
  images,
  initialIndex,
  onClose,
}: {
  siteId: string;
  images: ImageItem[];
  initialIndex: number;
  onClose: () => void;
}): React.JSX.Element {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const currentImage = images[currentIndex];

  const { data } = useQuery({
    queryKey: ['location-image-url', siteId, currentImage?.id],
    queryFn: () =>
      api.get<{ downloadUrl: string }>(
        `/v1/portal/chargers/location/${siteId}/images/${String(currentImage?.id ?? 0)}/download-url`,
      ),
    enabled: currentImage != null,
    staleTime: 1000 * 60 * 50,
  });

  const goNext = useCallback(() => {
    setCurrentIndex((i) => (i + 1) % images.length);
  }, [images.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i - 1 + images.length) % images.length);
  }, [images.length]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') goNext();
      if (e.key === 'ArrowLeft') goPrev();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, goNext, goPrev]);

  // Handle swipe
  const [touchStart, setTouchStart] = useState<number | null>(null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onTouchStart={(e) => {
        const touch = e.touches[0];
        if (touch != null) setTouchStart(touch.clientX);
      }}
      onTouchEnd={(e) => {
        if (touchStart == null) return;
        const touch = e.changedTouches[0];
        if (touch == null) return;
        const diff = touch.clientX - touchStart;
        if (Math.abs(diff) > 50) {
          if (diff > 0) goPrev();
          else goNext();
        }
        setTouchStart(null);
      }}
    >
      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>

      {/* Previous */}
      {images.length > 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          className="absolute left-2 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
          aria-label="Previous"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}

      {/* Image */}
      <div className="flex max-h-[80vh] max-w-[90vw] flex-col items-center gap-3">
        {data?.downloadUrl != null ? (
          <img
            src={data.downloadUrl}
            alt={currentImage?.caption ?? currentImage?.fileName ?? ''}
            className="max-h-[75vh] max-w-full rounded-lg object-contain"
          />
        ) : (
          <div className="flex h-64 w-64 items-center justify-center rounded-lg bg-muted">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}
        {currentImage?.caption != null && (
          <p className="text-center text-sm text-white/80">{currentImage.caption}</p>
        )}
        {images.length > 1 && (
          <p className="text-xs text-white/60">
            {String(currentIndex + 1)} / {String(images.length)}
          </p>
        )}
      </div>

      {/* Next */}
      {images.length > 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          className="absolute right-2 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
          aria-label="Next"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      )}
    </div>
  );
}

export function ImageCarousel({ siteId }: ImageCarouselProps): React.JSX.Element | null {
  const [overlayIndex, setOverlayIndex] = useState<number | null>(null);

  const { data: images } = useQuery({
    queryKey: ['location-images', siteId],
    queryFn: () => api.get<ImageItem[]>(`/v1/portal/chargers/location/${siteId}/images`),
  });

  if (images == null || images.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {images.map((image, index) => (
          <ImageThumbnail
            key={image.id}
            siteId={siteId}
            image={image}
            onClick={() => {
              setOverlayIndex(index);
            }}
          />
        ))}
      </div>
      {overlayIndex != null && (
        <ImageOverlay
          siteId={siteId}
          images={images}
          initialIndex={overlayIndex}
          onClose={() => {
            setOverlayIndex(null);
          }}
        />
      )}
    </>
  );
}
