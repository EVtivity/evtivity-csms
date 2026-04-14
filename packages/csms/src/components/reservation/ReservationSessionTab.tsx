// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCents, formatDuration } from '@/lib/formatting';
import { simpleSessionStatusVariant } from '@/lib/status-variants';

function formatSessionEnergy(wh: string | null): string {
  if (wh == null) return '--';
  const kwh = Number(wh) / 1000;
  return `${kwh.toFixed(2)} kWh`;
}

export interface ReservationSessionTabProps {
  sessionId: string;
  sessionStatus: string | null;
  sessionEnergyWh: string | null;
  sessionCostCents: number | null;
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
}

export function ReservationSessionTab({
  sessionId,
  sessionStatus,
  sessionEnergyWh,
  sessionCostCents,
  sessionStartedAt,
  sessionEndedAt,
}: ReservationSessionTabProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('reservations.sessionTab')}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-muted-foreground">{t('common.status')}</dt>
            <dd className="font-medium">
              <Badge variant={simpleSessionStatusVariant(sessionStatus ?? '')}>
                {sessionStatus ?? '--'}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('sessions.energy')}</dt>
            <dd className="font-medium">{formatSessionEnergy(sessionEnergyWh)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('sessions.cost')}</dt>
            <dd className="font-medium text-success">{formatCents(sessionCostCents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('sessions.duration')}</dt>
            <dd className="font-medium">{formatDuration(sessionStartedAt, sessionEndedAt)}</dd>
          </div>
        </dl>
        <div className="mt-4">
          <Link to={`/sessions/${sessionId}`}>
            <Button variant="outline" size="sm">
              {t('reservations.viewSession')}
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
