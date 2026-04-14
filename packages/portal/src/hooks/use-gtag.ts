// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function useGtag(): void {
  const { data: branding } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
  });

  const gtagId = branding?.gtagPortal;

  useEffect(() => {
    if (gtagId == null || gtagId === '') return;

    const existingScript = document.querySelector(`script[src*="googletagmanager.com/gtag/js"]`);
    if (existingScript != null) return;

    const dataLayer = window.dataLayer || [];
    window.dataLayer = dataLayer;
    window.gtag = function (...args: unknown[]) {
      dataLayer.push(args);
    };
    window.gtag('js', new Date());
    window.gtag('config', gtagId);

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gtagId)}`;
    document.head.appendChild(script);

    return () => {
      script.remove();
    };
  }, [gtagId]);
}
