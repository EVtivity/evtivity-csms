// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The SVG drawn in the center of station QR codes (`qr_code_icon`). Read from
 * the public branding endpoint, so it works without settings permissions.
 */
export function useQrIcon(): { svgDataUri: string | null } {
  const { data: branding } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
  });

  const svg = branding?.['qrCodeIcon'];
  if (typeof svg !== 'string' || svg === '') {
    return { svgDataUri: null };
  }

  return { svgDataUri: `data:image/svg+xml;base64,${btoa(svg)}` };
}
