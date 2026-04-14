// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';

interface SupportCase {
  id: string;
  caseNumber: string;
  subject: string;
  status: string;
  category: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse {
  data: SupportCase[];
  total: number;
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'open':
      return 'default';
    case 'in_progress':
      return 'secondary';
    case 'resolved':
      return 'secondary';
    case 'closed':
    case 'waiting_on_driver':
      return 'outline';
    default:
      return 'outline';
  }
}

export function SupportCases(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useDriverTimezone();

  const { data, isLoading } = useQuery({
    queryKey: ['portal-support-cases'],
    queryFn: () => api.get<PaginatedResponse>('/v1/portal/support-cases?limit=50'),
  });

  const cases = data?.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader title={t('supportCases.title')}>
        <Button
          size="sm"
          onClick={() => {
            void navigate('/support/new');
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          {t('supportCases.newCase')}
        </Button>
      </PageHeader>

      {isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}

      {cases.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">{t('supportCases.noCases')}</p>
      )}

      {cases.map((c) => (
        <Card
          key={c.id}
          className="cursor-pointer"
          onClick={() => {
            void navigate(`/support/${c.id}`);
          }}
        >
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{c.caseNumber}</span>
              <Badge variant={statusVariant(c.status)}>
                {t(`supportCases.statuses.${c.status}`)}
              </Badge>
            </div>
            <p className="font-medium text-sm truncate">{c.subject}</p>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t(`supportCases.categories.${c.category}`)}</span>
              <span>{formatDate(c.updatedAt, timezone)}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
