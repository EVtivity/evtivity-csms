// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';
import type { PricingGroup } from '@/lib/types';

interface PricingGroupDetailsTabProps {
  group: PricingGroup;
  timezone: string;
  onDeleted: () => void;
}

export function PricingGroupDetailsTab({
  group,
  timezone,
  onDeleted,
}: PricingGroupDetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (body: { name?: string; description?: string | null }) =>
      api.patch<PricingGroup>(`/v1/pricing-groups/${group.id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pricing-groups', group.id] });
      void queryClient.invalidateQueries({ queryKey: ['pricing-groups'] });
      setEditing(false);
      setHasSubmitted(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete<undefined>(`/v1/pricing-groups/${group.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pricing-groups'] });
      onDeleted();
    },
  });

  function startEdit(): void {
    setName(group.name);
    setDescription(group.description ?? '');
    setHasSubmitted(false);
    setEditing(true);
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('validation.required');
    return errors;
  }

  const validationErrors = getValidationErrors();

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(validationErrors).length > 0) return;
    updateMutation.mutate({
      name,
      description: description.trim() !== '' ? description : null,
    });
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="flex gap-2">
            {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
            <RemoveButton
              label={t('common.delete')}
              onClick={() => {
                setDeleteOpen(true);
              }}
            />
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <form onSubmit={handleSave} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">{t('common.name')}</Label>
                <Input
                  id="edit-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                  className={hasSubmitted && validationErrors.name ? 'border-destructive' : ''}
                />
                {hasSubmitted && validationErrors.name && (
                  <p className="text-sm text-destructive">{validationErrors.name}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-description">{t('common.description')}</Label>
                <Input
                  id="edit-description"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                  }}
                />
              </div>
              <div className="flex gap-2">
                <SaveButton isPending={updateMutation.isPending} />
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                    setHasSubmitted(false);
                  }}
                />
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('common.name')}</dt>
                <dd className="font-medium">{group.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.description')}</dt>
                <dd className="font-medium">{group.description ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.default')}</dt>
                <dd>
                  {group.isDefault ? <Badge variant="default">{t('common.default')}</Badge> : '--'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.created')}</dt>
                <dd className="font-medium">{formatDateTime(group.createdAt, timezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.lastUpdated')}</dt>
                <dd className="font-medium">{formatDateTime(group.updatedAt, timezone)}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('common.delete')}
        description={t('pricing.confirmDeleteGroupDesc')}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate();
        }}
      />
    </>
  );
}
