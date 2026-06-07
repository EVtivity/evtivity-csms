// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CreateButton } from '@/components/create-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { LoadingLogo } from '@/components/loading-logo';

interface ConfigTemplate {
  id: string;
  name: string;
  description: string | null;
  variables: unknown[];
  matchingStationsCount: number;
  createdAt: string;
}

export function ConfigTemplates({ embedded }: { embedded?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const timezone = useUserTimezone();
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<ConfigTemplate | null>(null);
  const limit = 10;

  const { data, isLoading } = useQuery({
    queryKey: ['config-templates', page],
    queryFn: () =>
      api.get<{ data: ConfigTemplate[]; total: number }>(
        `/v1/config-templates?page=${String(page)}&limit=${String(limit)}`,
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/config-templates/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config-templates'] });
      setDeleteTarget(null);
    },
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
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle>{t('nav.configTemplates')}</CardTitle>
              <CardDescription>{t('configTemplates.subtitle')}</CardDescription>
            </div>
            {createBtn}
          </CardHeader>
        )}
        <CardContent className={embedded ? '' : 'pt-6'}>
          {isLoading ? (
            <LoadingLogo size="inline" />
          ) : data == null || data.data.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              {t('configTemplates.noTemplates')}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('common.name')}</TableHead>
                      <TableHead>{t('common.description')}</TableHead>
                      <TableHead>{t('configTemplates.variableCount')}</TableHead>
                      <TableHead className="text-right">
                        {t('configTemplates.matchingStations')}
                      </TableHead>
                      <TableHead>{t('common.created')}</TableHead>
                      <TableHead className="w-12" />
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
                        <TableCell className="text-xs whitespace-normal break-words max-w-md">
                          {template.description ?? 'n/a'}
                        </TableCell>
                        <TableCell className="text-xs">
                          {Array.isArray(template.variables) ? template.variables.length : 0}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {template.matchingStationsCount}
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatDateTime(template.createdAt, timezone)}
                        </TableCell>
                        <TableCell
                          className="text-right"
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                        >
                          <RemoveIconButton
                            title={t('common.delete')}
                            size="sm"
                            onClick={() => {
                              setDeleteTarget(template);
                            }}
                          />
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

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('configTemplates.confirmDelete')}
        description={t('configTemplates.confirmDeleteDescription')}
        confirmLabel={t('common.delete')}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget != null) {
            deleteMutation.mutate(deleteTarget.id);
          }
          return false;
        }}
      />
    </>
  );

  if (embedded) return content;

  return <div className="px-4 py-4 md:px-6 md:py-6 space-y-6">{content}</div>;
}
