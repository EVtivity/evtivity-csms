// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import QrScanner from 'qr-scanner';
import { AlertCircle, ArrowLeft } from 'lucide-react';
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

type ScanState = 'starting' | 'scanning' | 'denied' | 'noCamera';

export function ScanQr(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<ScanState>('starting');

  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;

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

    void QrScanner.hasCamera().then((hasCamera) => {
      if (cancelled) return;
      if (!hasCamera) {
        setState('noCamera');
        return;
      }
      scanner.start().then(
        () => {
          if (!cancelled) setState('scanning');
        },
        () => {
          if (!cancelled) setState('denied');
        },
      );
    });

    return () => {
      cancelled = true;
      scanner.destroy();
    };
  }, [navigate]);

  const blocked = state === 'denied' || state === 'noCamera';

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
            <p className="text-sm font-medium">
              {state === 'denied' ? t('scanQr.permissionDenied') : t('scanQr.noCamera')}
            </p>
          </div>
        )}
      </div>

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
