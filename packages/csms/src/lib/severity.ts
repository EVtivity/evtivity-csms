// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_VARIANT: Record<
  string,
  'destructive' | 'warning' | 'secondary' | 'outline' | 'info'
> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'warning',
  low: 'secondary',
  info: 'outline',
};
