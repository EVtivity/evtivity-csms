// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useQrIcon(): { svgDataUri: string | null } {
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/settings'),
  });

  if (settings == null || typeof settings['qr_code_icon'] !== 'string') {
    return { svgDataUri: null };
  }

  const svg = settings['qr_code_icon'];
  const encoded = btoa(svg);
  return { svgDataUri: `data:image/svg+xml;base64,${encoded}` };
}
