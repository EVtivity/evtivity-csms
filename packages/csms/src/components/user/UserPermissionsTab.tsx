// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EditButton } from '@/components/edit-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PermissionEditor } from '@/components/PermissionEditor';
import { api } from '@/lib/api';

export interface UserPermissionsTabProps {
  userId: string;
}

export function UserPermissionsTab({ userId }: UserPermissionsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [editingPermissions, setEditingPermissions] = useState(false);
  const [editPermissions, setEditPermissions] = useState<string[]>([]);

  const { data: userPermissions = [] } = useQuery({
    queryKey: ['users', userId, 'permissions'],
    queryFn: () => api.get<string[]>(`/v1/users/${userId}/permissions`),
  });

  const permissionsMutation = useMutation({
    mutationFn: (perms: string[]) =>
      api.put<string[]>(`/v1/users/${userId}/permissions`, { permissions: perms }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users', userId, 'permissions'] });
      setEditingPermissions(false);
    },
  });

  function startEditPermissions(): void {
    setEditPermissions([...userPermissions]);
    setEditingPermissions(true);
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('users.permissions')}</CardTitle>
        {!editingPermissions && (
          <EditButton label={t('common.edit')} onClick={startEditPermissions} />
        )}
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">{t('users.writeImpliesRead')}</p>
        {userPermissions.length === 0 && !editingPermissions ? (
          <p className="text-center text-sm text-muted-foreground">{t('users.noPermissions')}</p>
        ) : (
          <div className="space-y-4">
            <PermissionEditor
              value={editingPermissions ? editPermissions : userPermissions}
              onChange={setEditPermissions}
              disabled={!editingPermissions}
            />
            {editingPermissions && (
              <div className="flex justify-end gap-2">
                <CancelButton
                  onClick={() => {
                    setEditingPermissions(false);
                  }}
                />
                <SaveButton
                  isPending={permissionsMutation.isPending}
                  onClick={() => {
                    permissionsMutation.mutate(editPermissions);
                  }}
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
