// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link, useParams } from 'react-router-dom';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SessionsTable, type Session } from '@/components/SessionsTable';
import { TokenDetailsTab } from '@/components/token/TokenDetailsTab';
import { AuthorizeLogView } from '@/components/AuthorizeLogView';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { useUserTimezone } from '@/lib/timezone';
import { formatDateTime } from '@/lib/timezone';

interface AuditEntry {
  id: number;
  action: string;
  actor: string;
  actorUserId: string | null;
  actorUserName: string | null;
  actorDriverId: string | null;
  actorDriverName: string | null;
  notes: string | null;
  createdAt: string;
}

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
  } = usePaginatedQuery<Session>(`token-sessions-${id ?? ''}`, `/v1/tokens/${id ?? ''}/sessions`);

  const {
    data: audit,
    isLoading: auditLoading,
    page: auditPage,
    totalPages: auditTotalPages,
    setPage: setAuditPage,
  } = usePaginatedQuery<AuditEntry>(`token-audit-${id ?? ''}`, `/v1/tokens/${id ?? ''}/audit`);

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
          <TabsTrigger value="history">{t('tokens.history')}</TabsTrigger>
          <TabsTrigger value="authorize-log">{t('tokens.authorizeLog')}</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-4 space-y-4">
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

        <TabsContent value="history" className="mt-4">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('common.timestamp')}</TableHead>
                      <TableHead>{t('common.action')}</TableHead>
                      <TableHead>{t('common.actor')}</TableHead>
                      <TableHead>{t('common.notes')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditLoading ? (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="text-center text-sm text-muted-foreground"
                        >
                          {t('common.loading')}
                        </TableCell>
                      </TableRow>
                    ) : audit == null || audit.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="text-center text-sm text-muted-foreground"
                        >
                          {t('tokens.noHistory')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      audit.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="text-xs whitespace-nowrap">
                            {formatDateTime(row.createdAt, timezone)}
                          </TableCell>
                          <TableCell>
                            <span className="text-sm font-medium capitalize">{row.action}</span>
                          </TableCell>
                          <TableCell className="text-xs">
                            {row.actorUserId != null ? (
                              <Link
                                to={`/users/${row.actorUserId}`}
                                className="text-primary hover:underline"
                              >
                                {row.actorUserName ?? row.actor}
                              </Link>
                            ) : row.actorDriverId != null ? (
                              <Link
                                to={`/drivers/${row.actorDriverId}`}
                                className="text-primary hover:underline"
                              >
                                {row.actorDriverName ?? row.actor}
                              </Link>
                            ) : (
                              <span>{row.actor}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {row.notes != null && row.notes !== '' ? row.notes : '--'}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              {auditTotalPages > 1 && (
                <Pagination
                  page={auditPage}
                  totalPages={auditTotalPages}
                  onPageChange={setAuditPage}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="authorize-log" className="mt-4">
          <AuthorizeLogView
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
