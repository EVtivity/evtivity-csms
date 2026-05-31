// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Badge } from '@/components/ui/badge';
import { type NotificationRecord, statusBadgeClass, formatFailureReason } from './shared';

interface StatusCellProps {
  status: NotificationRecord['status'];
  metadata: NotificationRecord['metadata'];
}

export function StatusCell({ status, metadata }: StatusCellProps): React.JSX.Element {
  const failureText = status === 'failed' ? formatFailureReason(metadata?.failureReason) : null;
  return (
    <div className="flex flex-col gap-1">
      <Badge className={statusBadgeClass(status)}>{status}</Badge>
      {failureText != null && <span className="text-xs text-muted-foreground">{failureText}</span>}
    </div>
  );
}
