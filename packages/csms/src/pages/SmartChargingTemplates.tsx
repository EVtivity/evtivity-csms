// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CreateButton } from '@/components/create-button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';
import { useUserTimezone } from '@/lib/timezone';

interface SmartChargingTemplate {
  id: string;
  name: string;
  description: string | null;
  profilePurpose: string;
  profileKind: string;
  chargingRateUnit: string;
  ocppVersion: string;
  createdAt: string;
}

export function SmartChargingTemplates({
  embedded,
}: { embedded?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const [page, setPage] = useState(1);
  const limit = 25;

  const { data, isLoading } = useQuery({
    queryKey: ['smart-charging-templates', page],
    queryFn: () =>
      api.get<{ data: SmartChargingTemplate[]; total: number }>(
        `/v1/smart-charging/templates?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 1;

  const createBtn = (
    <CreateButton
      label={t('smartCharging.createTemplate')}
      onClick={() => {
        void navigate('/smart-charging/new');
      }}
    />
  );

  const content = (
    <>
      {!embedded && (
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl md:text-3xl font-bold">{t('smartCharging.title')}</h1>
          {createBtn}
        </div>
      )}

      <Card>
        {embedded && (
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="space-y-1.5">
              <CardTitle>{t('smartCharging.title')}</CardTitle>
              <CardDescription>{t('smartCharging.subtitle')}</CardDescription>
            </div>
            {createBtn}
          </CardHeader>
        )}
        <CardContent className={embedded ? '' : 'pt-6'}>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : data == null || data.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('smartCharging.noTemplates')}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('common.name')}</TableHead>
                      <TableHead>{t('smartCharging.profilePurpose')}</TableHead>
                      <TableHead>{t('smartCharging.profileKind')}</TableHead>
                      <TableHead>{t('smartCharging.chargingRateUnit')}</TableHead>
                      <TableHead>{t('smartCharging.ocppVersion')}</TableHead>
                      <TableHead>{t('common.created')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.data.map((template) => (
                      <TableRow
                        key={template.id}
                        className="cursor-pointer hover:bg-muted/50"
                        data-testid={`smart-charging-template-row-${template.id}`}
                        onClick={() => {
                          void navigate(`/smart-charging/${template.id}`);
                        }}
                      >
                        <TableCell className="font-medium" data-testid="row-click-target">
                          {template.name}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            {(t as (key: string, opts?: Record<string, unknown>) => string)(
                              `smartCharging.purposes.${template.profilePurpose}`,
                              { defaultValue: template.profilePurpose },
                            )}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {(t as (key: string, opts?: Record<string, unknown>) => string)(
                            `smartCharging.kinds.${template.profileKind}`,
                            { defaultValue: template.profileKind },
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{template.chargingRateUnit}</TableCell>
                        <TableCell className="text-xs">OCPP {template.ocppVersion}</TableCell>
                        <TableCell className="text-xs">
                          {formatDateTime(template.createdAt, timezone)}
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
    </>
  );

  if (embedded) return content;

  return <div className="px-4 py-4 md:px-6 md:py-6 space-y-6">{content}</div>;
}
