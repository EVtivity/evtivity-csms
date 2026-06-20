// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import QrScanner from 'qr-scanner';
import { AlertCircle, ArrowLeft, Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Station QR codes encode a charge link such as
// https://host/charge/CS-0439/1 or https://host/charge/CS-0439. Pull the
// station id (and optional connector) out of whatever the camera decoded,
// whether it is a full URL or a bare path, and ignore anything else.
function parseChargeTarget(raw: string): { stationId: string; evseId?: string } | null {
  let path = raw.trim();
  try {
    path = new URL(path).pathname;
  } catch {
    // Not a full URL; treat the decoded text as a path.
  }
  const segments = path.split('?')[0]?.split('/').filter(Boolean) ?? [];
  const chargeIndex = segments.indexOf('charge');
  const base = chargeIndex === -1 ? 0 : chargeIndex + 1;
  const stationId = segments[base];
  if (stationId == null || stationId === '') return null;
  const evseId = segments[base + 1];
  return evseId != null && evseId !== '' ? { stationId, evseId } : { stationId };
}

type ScanState = 'starting' | 'scanning' | 'denied' | 'noCamera' | 'insecure';

export function ScanQr(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ScanState>('starting');
  const [photoError, setPhotoError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;

    // The camera APIs exist only in a secure context (HTTPS or localhost). Over
    // plain HTTP navigator.mediaDevices is undefined and the camera can never
    // open, so surface that as its own message instead of a misleading "no camera".
    if (!window.isSecureContext) {
      setState('insecure');
      return;
    }

    let cancelled = false;
    const scanner = new QrScanner(
      video,
      (result) => {
        const target = parseChargeTarget(result.data);
        if (target == null) return;
        scanner.stop();
        const query = target.evseId != null ? `?evse=${target.evseId}` : '';
        void navigate(`/start/${target.stationId}${query}`);
      },
      { highlightScanRegion: true, highlightCodeOutline: true, preferredCamera: 'environment' },
    );

    // start() surfaces the real getUserMedia error, which distinguishes a denied
    // permission from a device that genuinely has no camera.
    scanner.start().then(
      () => {
        if (!cancelled) setState('scanning');
      },
      (err: unknown) => {
        if (cancelled) return;
        const name = err instanceof Error ? err.name : '';
        setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'noCamera');
      },
    );

    return () => {
      cancelled = true;
      scanner.destroy();
    };
  }, [navigate]);

  // Photo fallback: decode a still image instead of a live stream. A file input
  // with capture="environment" opens the native camera even on an insecure (HTTP)
  // page, and scanImage() never touches getUserMedia, so this works everywhere.
  async function decodePhoto(file: File): Promise<void> {
    setPhotoError(false);
    try {
      const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
      const target = parseChargeTarget(result.data);
      if (target == null) {
        setPhotoError(true);
        return;
      }
      const query = target.evseId != null ? `?evse=${target.evseId}` : '';
      void navigate(`/start/${target.stationId}${query}`);
    } catch {
      setPhotoError(true);
    }
  }

  const blocked = state === 'denied' || state === 'noCamera' || state === 'insecure';
  const blockedMessage =
    state === 'denied'
      ? t('scanQr.permissionDenied')
      : state === 'insecure'
        ? t('scanQr.insecureContext')
        : t('scanQr.noCamera');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.back')}
          onClick={() => {
            void navigate(-1);
          }}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold">{t('scanQr.title')}</h1>
      </div>

      <p className="text-sm text-muted-foreground">{t('scanQr.instruction')}</p>

      <div className="relative aspect-square w-full overflow-hidden rounded-lg border bg-muted">
        <video ref={videoRef} className="h-full w-full object-cover" />
        {blocked && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertCircle className="h-10 w-10 text-destructive" />
            <p className="text-sm font-medium">{blockedMessage}</p>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file != null) void decodePhoto(file);
        }}
      />

      <Button
        variant={blocked ? 'default' : 'outline'}
        className="w-full"
        onClick={() => {
          fileInputRef.current?.click();
        }}
      >
        <Camera className="mr-2 h-4 w-4" />
        {t('scanQr.scanPhoto')}
      </Button>

      {photoError && (
        <p className="text-center text-sm text-destructive">{t('scanQr.noQrFound')}</p>
      )}

      <Button
        variant="outline"
        className="w-full"
        onClick={() => {
          void navigate('/start');
        }}
      >
        {t('scanQr.searchInstead')}
      </Button>
    </div>
  );
}
