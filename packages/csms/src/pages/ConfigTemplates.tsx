// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CreateButton } from '@/components/create-button';
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

interface ConfigTemplate {
  id: string;
  name: string;
  description: string | null;
  variables: unknown[];
  createdAt: string;
}

export function ConfigTemplates({ embedded }: { embedded?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();
  const [page, setPage] = useState(1);
  const limit = 25;

  const { data, isLoading } = useQuery({
    queryKey: ['config-templates', page],
    queryFn: () =>
      api.get<{ data: ConfigTemplate[]; total: number }>(
        `/v1/config-templates?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const totalPages = data != null ? Math.ceil(data.total / limit) : 1;

  const createBtn = (
    <CreateButton
      label={t('common.create')}
      onClick={() => {
        void navigate('/station-configurations/new');
      }}
    />
  );

  const content = (
    <>
      {!embedded && (
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl md:text-3xl font-bold">{t('nav.configTemplates')}</h1>
          {createBtn}
        </div>
      )}

      <Card>
        {embedded && (
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="space-y-1.5">
              <CardTitle>{t('nav.configTemplates')}</CardTitle>
              <CardDescription>{t('configTemplates.subtitle')}</CardDescription>
            </div>
            {createBtn}
          </CardHeader>
        )}
        <CardContent className={embedded ? '' : 'pt-6'}>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : data == null || data.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('configTemplates.noTemplates')}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('common.name')}</TableHead>
                      <TableHead>{t('common.description')}</TableHead>
                      <TableHead>{t('configTemplates.variableCount')}</TableHead>
                      <TableHead>{t('common.created')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.data.map((template) => (
                      <TableRow
                        key={template.id}
                        className="cursor-pointer hover:bg-muted/50"
                        data-testid={`config-template-row-${template.id}`}
                        onClick={() => {
                          void navigate(`/station-configurations/${template.id}`);
                        }}
                      >
                        <TableCell className="font-medium" data-testid="row-click-target">
                          {template.name}
                        </TableCell>
                        <TableCell className="text-xs">{template.description ?? '--'}</TableCell>
                        <TableCell className="text-xs">
                          {Array.isArray(template.variables) ? template.variables.length : 0}
                        </TableCell>
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
