// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Zap, CreditCard, Wifi, Car, HelpCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { formatCents, formatEnergy, formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';

interface Session {
  id: string;
  status: string;
  startedAt: string | null;
  energyDeliveredWh: string | null;
  finalCostCents: number | null;
  currency: string | null;
  stationName: string | null;
  siteName: string | null;
}

interface SessionsResponse {
  data: Session[];
  total: number;
}

interface ActiveSession {
  id: string;
  stationId: string;
  transactionId: string;
  startedAt: string | null;
  energyDeliveredWh: string | null;
  currentCostCents: number | null;
  currency: string | null;
}

interface ActiveSessionsResponse {
  data: ActiveSession[];
}

export function Home(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const driver = useAuth((s) => s.driver);
  const timezone = useDriverTimezone();

  const { data: sessions } = useQuery({
    queryKey: ['portal-sessions-recent'],
    queryFn: () => api.get<SessionsResponse>('/v1/portal/sessions?limit=3'),
    refetchInterval: 30000,
  });

  const { data: activeSessionsResponse } = useQuery({
    queryKey: ['portal-active-sessions'],
    queryFn: () => api.get<ActiveSessionsResponse>('/v1/portal/chargers/sessions/active'),
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          {t('home.greeting', { name: driver?.firstName ?? 'Driver' })}
        </h1>
        <p className="text-muted-foreground">{t('home.readyToCharge')}</p>
      </div>

      {activeSessionsResponse != null && activeSessionsResponse.data.length > 0 && (
        <Card
          className="border-success bg-success/5 cursor-pointer animate-border-pulse"
          onClick={() => {
            const first = activeSessionsResponse.data[0];
            if (first != null) void navigate(`/sessions/${first.id}`);
          }}
        >
          <CardContent className="flex items-center gap-3 p-3">
            <Zap className="h-5 w-5 text-success animate-pulse" />
            <div>
              <p className="text-sm font-bold">{t('home.activeSession')}</p>
              <p className="text-xs text-muted-foreground">
                {activeSessionsResponse.data[0]?.stationId ?? t('home.unknownStation')}
                {' - '}
                {formatEnergy(activeSessionsResponse.data[0]?.energyDeliveredWh)}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3">
        <Card
          className="cursor-pointer hover:bg-accent/50 transition-colors"
          onClick={() => {
            void navigate('/payment-methods');
          }}
        >
          <CardContent className="flex flex-col items-center gap-2 p-4">
            <CreditCard className="h-8 w-8 text-primary" />
            <span className="text-sm font-medium">{t('home.paymentMethods')}</span>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer hover:bg-accent/50 transition-colors"
          onClick={() => {
            void navigate('/rfid-cards');
          }}
        >
          <CardContent className="flex flex-col items-center gap-2 p-4">
            <Wifi className="h-8 w-8 text-primary" />
            <span className="text-sm font-medium">{t('home.rfidCards')}</span>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer hover:bg-accent/50 transition-colors"
          onClick={() => {
            void navigate('/vehicles');
          }}
        >
          <CardContent className="flex flex-col items-center gap-2 p-4">
            <Car className="h-8 w-8 text-primary" />
            <span className="text-sm font-medium">{t('home.vehicles')}</span>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer hover:bg-accent/50 transition-colors"
          onClick={() => {
            void navigate('/support');
          }}
        >
          <CardContent className="flex flex-col items-center gap-2 p-4">
            <HelpCircle className="h-8 w-8 text-primary" />
            <span className="text-sm font-medium">{t('home.supportCases')}</span>
          </CardContent>
        </Card>
      </div>

      {/* Recent sessions */}
      {sessions != null && sessions.data.length > 0 && (
        <div>
          <h2 className="mb-3 text-lg font-semibold">{t('home.recentSessions')}</h2>
          <div className="space-y-2">
            {sessions.data.map((session) => (
              <Card
                key={session.id}
                className="cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => {
                  void navigate(`/sessions/${session.id}`);
                }}
              >
                <CardContent className="flex items-center justify-between p-3">
                  <div>
                    <p className="text-sm font-medium">
                      {session.stationName ?? t('home.unknownStation')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(session.startedAt, timezone)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">{formatEnergy(session.energyDeliveredWh)}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatCents(session.finalCostCents, session.currency ?? 'USD')}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
