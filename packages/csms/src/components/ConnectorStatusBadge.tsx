// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Pause } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { connectorStatusClassName, connectorStatusVariant } from '@/lib/status-variants';

/**
 * The connector status every connector view shows (the station Connectors
 * tab, the site layout card and popup): the status word on the color of
 * its status (css-spec section 12), an idle occupied connector as Idle.
 */
export function ConnectorStatusBadge({
  status,
  isIdling,
  className,
}: {
  status: string;
  isIdling?: boolean | undefined;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Badge
      variant={connectorStatusVariant(status, isIdling)}
      className={cn(connectorStatusClassName(status, isIdling), className)}
      data-testid="connector-status-badge"
      data-status={status}
    >
      {isIdling === true && <Pause className="h-3 w-3" aria-hidden="true" />}
      {isIdling === true ? t('status.idle') : t(`status.${status}`, { defaultValue: status })}
    </Badge>
  );
}
