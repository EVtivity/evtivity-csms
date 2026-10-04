// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyableId } from '@/components/copyable-id';
import { PORTAL_BASE_URL } from '@/lib/config';
import { formatDateTime } from '@/lib/timezone';
import { providerLabel } from '@/payments/provider-label';

interface GuestSessionInfo {
  sessionToken: string;
  guestEmail: string;
  status: string;
  preAuthAmountCents: number | null;
  provider: string | null;
  providerPaymentId: string | null;
  expiresAt: string;
  createdAt: string;
}

interface SessionGuestTabProps {
  guest: GuestSessionInfo;
  currency: string;
  timezone: string;
  formatCents: (cents: number | null | undefined, currency: string) => string;
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-muted-foreground shrink-0 w-40">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function SessionGuestTab({
  guest,
  currency,
  timezone,
  formatCents,
}: SessionGuestTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const portalUrl = `${PORTAL_BASE_URL}/guest-session/${guest.sessionToken}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sessions.guestSessionTab')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Row label={t('sessions.guestPortalLink')}>
          <a
            href={portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline break-all"
          >
            {portalUrl}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        </Row>
        <Row label={t('sessions.guestSessionToken')}>
          <CopyableId id={guest.sessionToken} variant="detail" />
        </Row>
        <Row label={t('sessions.guestEmail')}>
          {guest.guestEmail !== '' ? guest.guestEmail : '-'}
        </Row>
        <Row label={t('common.status')}>
          <Badge variant="secondary">{guest.status}</Badge>
        </Row>
        <Row label={t('sessions.guestPreAuthAmount')}>
          {guest.preAuthAmountCents != null ? formatCents(guest.preAuthAmountCents, currency) : '-'}
        </Row>
        <Row label={t('sessions.guestPaymentProvider')}>
          {guest.provider != null && guest.provider !== '' ? (
            <Badge variant="secondary">{providerLabel(guest.provider, t)}</Badge>
          ) : (
            '-'
          )}
        </Row>
        <Row label={t('sessions.guestProviderPayment')}>
          {guest.providerPaymentId != null && guest.providerPaymentId !== '' ? (
            <CopyableId id={guest.providerPaymentId} variant="detail" />
          ) : (
            '-'
          )}
        </Row>
        <Row label={t('sessions.guestCreatedAt')}>{formatDateTime(guest.createdAt, timezone)}</Row>
        <Row label={t('sessions.guestExpiresAt')}>{formatDateTime(guest.expiresAt, timezone)}</Row>
      </CardContent>
    </Card>
  );
}
