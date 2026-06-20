// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import { Zap } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { formatCents, formatEnergy, formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';
import { useHomeCards } from '@/lib/home-cards-store';
import { HOME_CARDS, type HomeCardId } from '@/lib/home-cards';

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
  stationName: string | null;
  transactionId: string;
  startedAt: string | null;
  energyDeliveredWh: string | null;
  currentCostCents: number | null;
  currency: string | null;
}

interface ActiveSessionsResponse {
  data: ActiveSession[];
}

function QuickActionCard({
  to,
  icon: Icon,
  label,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <Card
      className="cursor-pointer hover:bg-accent/50 transition-colors"
      onClick={() => {
        void navigate(to);
      }}
    >
      <CardContent className="flex flex-col items-center gap-2 p-4">
        <Icon className="h-8 w-8 text-primary" />
        <span className="text-sm font-medium">{label}</span>
      </CardContent>
    </Card>
  );
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

  // Public feature flags drive whether the Support quick-action is rendered.
  // Default to enabled while loading so the card doesn't flash in/out on
  // page mount. Cached for 5 minutes; toggling the system setting is rare.
  const { data: features } = useQuery({
    queryKey: ['portal-features'],
    queryFn: () =>
      api.get<{ reservationEnabled: boolean; supportEnabled: boolean }>('/v1/portal/features'),
    staleTime: 5 * 60_000,
  });
  const supportEnabled = features?.supportEnabled ?? true;

  // Driver-chosen quick-action cards. Drop Support when the operator has it off,
  // then pad three cards with a placeholder so the 2x2 grid keeps its shape; two
  // cards render as a single row and Recent sessions moves up beneath them.
  const homeCards = useHomeCards((s) => s.cards);
  const visibleCards = homeCards.filter((id) => id !== 'support' || supportEnabled);
  const cardSlots: (HomeCardId | null)[] =
    visibleCards.length === 3 ? [...visibleCards, null] : visibleCards;

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
                {activeSessionsResponse.data[0]?.stationName ??
                  activeSessionsResponse.data[0]?.stationId ??
                  t('home.unknownStation')}
                {' - '}
                {formatEnergy(activeSessionsResponse.data[0]?.energyDeliveredWh)}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3">
        {cardSlots.map((id, i) =>
          id == null ? (
            <div
              key={`home-card-placeholder-${String(i)}`}
              aria-hidden="true"
              className="rounded-lg border border-dashed border-border bg-muted/30"
            />
          ) : (
            <QuickActionCard
              key={id}
              to={HOME_CARDS[id].to}
              icon={HOME_CARDS[id].icon}
              label={t(HOME_CARDS[id].labelKey)}
            />
          ),
        )}
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
