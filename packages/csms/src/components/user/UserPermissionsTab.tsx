// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EditButton } from '@/components/edit-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { TabPanel } from '@/components/ui/tab-panel';
import { EmptyState } from '@/components/ui/content-state';
import { PermissionEditor } from '@/components/PermissionEditor';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';

export interface UserPermissionsTabProps {
  userId: string;
  /** False when the user holds permissions the operator lacks: the API refuses the change. */
  canEdit: boolean;
}

export function UserPermissionsTab({
  userId,
  canEdit,
}: UserPermissionsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [editingPermissions, setEditingPermissions] = useState(false);
  const [editPermissions, setEditPermissions] = useState<string[]>([]);
  // Granting a permission takes a fresh proof of the signed-in account; removing does not.
  const { data: mfaStatus } = useMfaStatus();
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const [proofAsked, setProofAsked] = useState(false);
  const [proofRound, setProofRound] = useState(0);

  const {
    data: userPermissions = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['users', userId, 'permissions'],
    queryFn: () => api.get<string[]>(`/v1/users/${userId}/permissions`),
  });

  const grants = editingPermissions && editPermissions.some((p) => !userPermissions.includes(p));
  const needsProof = grants && proofKinds.length > 0;

  const permissionsMutation = useMutation({
    mutationFn: (body: { permissions: string[]; proof?: FactorProof }) =>
      api.put<string[]>(`/v1/users/${userId}/permissions`, body),
    onError: (err: unknown) => {
      setProofFailure(proofRejection(err));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users', userId, 'permissions'] });
      setEditingPermissions(false);
    },
  });

  function startEditPermissions(): void {
    setEditPermissions([...userPermissions]);
    setEditingPermissions(true);
    setProof(null);
    setProofFailure(null);
    setProofAsked(false);
    setProofRound((n) => n + 1);
  }

  function save(): void {
    if (needsProof && proof == null) {
      setProofAsked(true);
      return;
    }
    permissionsMutation.mutate({
      permissions: editPermissions,
      ...(needsProof && proof != null ? { proof } : {}),
    });
  }

  return (
    <TabPanel
      title={t('users.permissions')}
      description={t('users.writeImpliesRead')}
      actions={
        canEdit && !editingPermissions ? (
          <EditButton label={t('common.edit')} onClick={startEditPermissions} />
        ) : undefined
      }
      isLoading={isLoading}
      isError={isError}
      onRetry={() => {
        void refetch();
      }}
    >
      {userPermissions.length === 0 && !editingPermissions ? (
        <EmptyState>{t('users.noPermissions')}</EmptyState>
      ) : (
        <div className="space-y-4">
          <PermissionEditor
            value={editingPermissions ? editPermissions : userPermissions}
            onChange={setEditPermissions}
            disabled={!editingPermissions}
          />
          {needsProof && (
            <FactorProofField
              key={`permissions-${String(proofRound)}`}
              idPrefix="user-permissions-proof"
              kinds={proofKinds}
              codeMethod={mfaStatus?.mfaMethod ?? null}
              description={t('users.grantProofHint')}
              onChange={setProof}
              rejection={proofFailure}
              showMissing={proofAsked}
            />
          )}
          {permissionsMutation.isError && (
            <p className="text-sm text-destructive" role="alert">
              {getErrorMessage(permissionsMutation.error, t)}
            </p>
          )}
          {editingPermissions && (
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  setEditingPermissions(false);
                }}
              />
              <SaveButton isPending={permissionsMutation.isPending} onClick={save} />
            </div>
          )}
        </div>
      )}
    </TabPanel>
  );
}
