// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { driverTokenStatus } from '@evtivity/lib/id-token-types';
import { Badge } from '@/components/ui/badge';

interface TokenStatusBadgeProps {
  token: {
    isActive: boolean;
    revokedAt?: string | null | undefined;
    expiresAt?: string | null | undefined;
  };
}

/**
 * The token status as the authorize check answers it: an inactive or revoked
 * token is refused first, then an active token past its expiry is Expired.
 */
export function TokenStatusBadge({ token }: TokenStatusBadgeProps): React.JSX.Element {
  const { t } = useTranslation();
  const status = driverTokenStatus(token);
  if (status === 'expired') return <Badge variant="warning">{t('tokens.expiredBadge')}</Badge>;
  if (status === 'revoked') return <Badge variant="destructive">{t('tokens.revokedBadge')}</Badge>;
  if (status === 'inactive') return <Badge variant="secondary">{t('common.inactive')}</Badge>;
  return <Badge variant="default">{t('common.active')}</Badge>;
}
