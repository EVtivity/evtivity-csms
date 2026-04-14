// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router-dom';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SessionsTable, type Session } from '@/components/SessionsTable';
import { TokenDetailsTab } from '@/components/token/TokenDetailsTab';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { useUserTimezone } from '@/lib/timezone';

interface TokenData {
  id: string;
  driverId: string | null;
  idToken: string;
  tokenType: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  driverFirstName: string | null;
  driverLastName: string | null;
  driverEmail: string | null;
}

export function TokenDetail(): React.JSX.Element {
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();

  const [activeTab, setActiveTab] = useTab('details');

  const {
    data: sessions,
    page: sessionsPage,
    totalPages: sessionsTotalPages,
    setPage: setSessionsPage,
  } = usePaginatedQuery<Session>('token-sessions', `/v1/tokens/${id ?? ''}/sessions`);

  const { data: token, isLoading } = useQuery({
    queryKey: ['tokens', id],
    queryFn: () => api.get<TokenData>(`/v1/tokens/${id ?? ''}`),
    enabled: id != null,
  });

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (token == null) {
    return <p className="text-destructive">{t('tokens.tokenNotFound')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/tokens" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{token.idToken}</h1>
          <CopyableId id={token.id} />
        </div>
        <Badge variant={token.isActive ? 'default' : 'outline'}>
          {token.isActive ? t('common.active') : t('common.inactive')}
        </Badge>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('tokens.tokenDetails')}</TabsTrigger>
          <TabsTrigger value="sessions">{t('sessions.title')}</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-4">
          <TokenDetailsTab token={token} timezone={timezone} />
        </TabsContent>

        <TabsContent value="sessions" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              <SessionsTable
                sessions={sessions}
                page={sessionsPage}
                totalPages={sessionsTotalPages}
                onPageChange={setSessionsPage}
                timezone={timezone}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
