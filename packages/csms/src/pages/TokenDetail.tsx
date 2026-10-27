// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { CopyableId } from '@/components/copyable-id';
import { TokenStatusBadge } from '@/components/token/TokenStatusBadge';
import { TabPanel } from '@/components/ui/tab-panel';
import { Pagination } from '@/components/ui/pagination';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SessionsTable, type Session } from '@/components/SessionsTable';
import { TokenDetailsTab } from '@/components/token/TokenDetailsTab';
import { AuthorizeLogView } from '@/components/AuthorizeLogView';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { useUserTimezone } from '@/lib/timezone';
import { LoadingLogo } from '@/components/loading-logo';

interface TokenData {
  id: string;
  driverId: string | null;
  idToken: string;
  tokenType: string;
  isActive: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  deactivatedBy: 'operator' | 'driver' | 'system' | null;
  prepaidBalanceCents: number | null;
  createdAt: string;
  updatedAt: string;
  driverFirstName: string | null;
  driverLastName: string | null;
  driverEmail: string | null;
}

export function TokenDetail(): React.JSX.Element {
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const canReadAudit = useHasPermission('audit:read');
  const { id } = useParams<{ id: string }>();

  const [activeTab, setActiveTab] = useTab('details');

  const {
    data: sessions,
    isLoading: sessionsLoading,
    isError: sessionsError,
    refetch: refetchSessions,
    page: sessionsPage,
    totalPages: sessionsTotalPages,
    setPage: setSessionsPage,
  } = usePaginatedQuery<Session>(`token-sessions-${id ?? ''}`, `/v1/tokens/${id ?? ''}/sessions`);

  const { data: token, isLoading } = useQuery({
    queryKey: ['tokens', id],
    queryFn: () => api.get<TokenData>(`/v1/tokens/${id ?? ''}`),
    enabled: id != null,
  });

  if (isLoading) {
    return <LoadingLogo />;
  }

  if (token == null) {
    return <p className="text-destructive">{t('tokens.tokenNotFound')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BackButton to="/tokens" />
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold wrap-anywhere">{token.idToken}</h1>
          <CopyableId id={token.id} />
        </div>
        <TokenStatusBadge token={token} />
        <EntityNavButtons resource="tokens" basePath="/tokens" currentId={id} />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="sessions">{t('sessions.title')}</TabsTrigger>
          {canReadAudit && <TabsTrigger value="history">{t('tokens.history')}</TabsTrigger>}
          <TabsTrigger value="authorize-log">{t('tokens.authorizeLog')}</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <TokenDetailsTab token={token} timezone={timezone} />
        </TabsContent>

        <TabsContent value="sessions">
          <TabPanel title={t('sessions.title')}>
            <SessionsTable
              sessions={sessions}
              page={sessionsPage}
              totalPages={sessionsTotalPages}
              onPageChange={setSessionsPage}
              timezone={timezone}
              isLoading={sessionsLoading}
              isError={sessionsError}
              onRetry={refetchSessions}
            />
            <Pagination
              page={sessionsPage}
              totalPages={sessionsTotalPages}
              onPageChange={setSessionsPage}
            />
          </TabPanel>
        </TabsContent>

        <TabsContent value="history">
          <EntityHistoryTab entityType="token" entityId={token.id} />
        </TabsContent>

        <TabsContent value="authorize-log">
          <AuthorizeLogView
            title={t('tokens.authorizeLog')}
            fixedFilters={{ matchedTokenId: token.id }}
            hideIdTokenFilter
            hideMatchedTokenColumn
            queryKey={`authorize-attempts-token-${token.id}`}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
