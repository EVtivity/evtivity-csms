// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface PushRecord {
  id: string;
  status: string;
  stationCount: number;
  acceptedCount: number;
  rejectedCount: number;
  failedCount: number;
  pendingCount: number;
  createdAt: string;
}

const PUSH_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'outline'> = {
  active: 'default',
  completed: 'secondary',
};

interface Props {
  templateId: string;
}

export function ConfigTemplatePushHistoryTab({ templateId }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const limit = 10;

  const { data: pushHistory } = useQuery({
    queryKey: ['config-templates', templateId, 'pushes', page],
    queryFn: () =>
      api.get<{ data: PushRecord[]; total: number }>(
        `/v1/config-templates/${templateId}/pushes?page=${String(page)}&limit=${String(limit)}`,
      ),
    refetchInterval: 5000,
  });

  const total = pushHistory?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('configTemplates.pushHistory')}</CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('configTemplates.noPushes')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('common.timestamp')}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead>{t('nav.stations')}</TableHead>
                    <TableHead>{t('configTemplates.accepted')}</TableHead>
                    <TableHead>{t('configTemplates.rejected')}</TableHead>
                    <TableHead>{t('configTemplates.failed')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pushHistory?.data.map((push) => (
                    <TableRow
                      key={push.id}
                      className="cursor-pointer"
                      data-testid={`config-push-row-${push.id}`}
                      onClick={() => {
                        void navigate(`/station-configuration-pushes/${push.id}`);
                      }}
                    >
                      <TableCell className="text-xs" data-testid="row-click-target">
                        {formatDateTime(push.createdAt, timezone)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={PUSH_STATUS_VARIANT[push.status] ?? 'outline'}>
                          {push.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{push.stationCount}</TableCell>
                      <TableCell>{push.acceptedCount}</TableCell>
                      <TableCell>
                        {push.rejectedCount > 0 ? (
                          <span className="text-warning">{push.rejectedCount}</span>
                        ) : (
                          0
                        )}
                      </TableCell>
                      <TableCell>
                        {push.failedCount > 0 ? (
                          <span className="text-destructive">{push.failedCount}</span>
                        ) : (
                          0
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
