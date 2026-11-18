// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FLEET_USER_PERMISSIONS, permissionCatalog } from '@evtivity/lib/permissions';
import { accessScopeForRole } from '@evtivity/lib/user-access-scope';
import {
  UserAccessField,
  accessKindForRole,
  offeredRoles,
  userAccessBody,
  type UserAccessKind,
} from '@/components/user/UserAccessField';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { roleLabel } from '@/lib/role-label';
import { PermissionEditor } from '@/components/PermissionEditor';
import { useHasAllSiteAccess } from '@/lib/auth';
import { api, getApiErrorFieldDetails } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { isAdminEquivalent } from '@evtivity/lib/admin-equivalent';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';
import { PendingAvatarField } from '@/components/avatar/PendingAvatarField';
import { useToast } from '@/components/ui/toast';
import { useCreatedToast } from '@/components/saved-message';
import { applyAvatarChoice, userAvatarPath, type AvatarChoice } from '@/lib/avatar';

interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  roleId: string;
}

interface Role {
  id: string;
  name: string;
  /** False for the Fleet Manager role while Fleets is off. */
  assignable?: boolean;
}

export function UserCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const createdToast = useCreatedToast();
  const canGrantAllSites = useHasAllSiteAccess();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  // A fleet page link (Add Fleet Manager) opens the form with a role and a fleet chosen.
  const [searchParams] = useSearchParams();
  const presetRole = searchParams.get('role');
  const presetFleetId = searchParams.get('fleetId');
  const [roleId, setRoleId] = useState('');
  const [accessKind, setAccessKind] = useState<UserAccessKind>(
    presetFleetId != null ? 'fleets' : 'sites',
  );
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);
  const [selectedFleetIds, setSelectedFleetIds] = useState<string[]>(
    presetFleetId != null && presetFleetId !== '' ? [presetFleetId] : [],
  );
  const featureFlags = useFeatureFlags();
  // The Fleet Manager role is offered only once Fleets is known to be on.
  const fleetEnabled = featureFlags.isLoaded && featureFlags.flags.fleetEnabled;
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [avatar, setAvatar] = useState<AvatarChoice | null>(null);
  const { toast } = useToast();
  // A signed-in session proves the account again to create an admin-equivalent user.
  const { data: mfaStatus } = useMfaStatus();
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const needsProof = proofKinds.length > 0 && isAdminEquivalent(selectedPermissions);

  const { data: roles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<Role[]>('/v1/roles'),
  });

  // The preset role is chosen once the roles have loaded.
  useEffect(() => {
    if (presetRole == null || roleId !== '' || roles == null) return;
    const preset = roles.find((r) => r.name === presetRole);
    if (preset != null) setRoleId(preset.id);
  }, [presetRole, roles]);

  const selectedRoleName = roles?.find((r) => r.id === roleId)?.name;
  // The role decides the access: Fleets for the Fleet Manager role only.
  const fleetManagerRole =
    selectedRoleName != null && accessScopeForRole(selectedRoleName) === 'fleets';

  // A role change sets its access (Fleets for the Fleet Manager role, else the
  // site access chosen, Sites by default) and restores the role defaults, the
  // seven fleet user permissions for the Fleet Manager role. Leaving the Fleet
  // Manager role clears the fleets picked for it.
  useEffect(() => {
    if (selectedRoleName == null) return;
    const kind = accessKindForRole(selectedRoleName, accessKind);
    if (accessKind === 'fleets' && kind !== 'fleets') setSelectedFleetIds([]);
    setAccessKind(kind);
    setSelectedPermissions(permissionCatalog.defaultsFor(selectedRoleName));
  }, [roleId, roles]);
  const createMutation = useMutation({
    mutationFn: async (body: {
      email: string;
      firstName?: string;
      lastName?: string;
      roleId: string;
      accessScope: 'sites' | 'fleets';
      hasAllSiteAccess?: boolean;
      siteIds?: string[];
      fleetIds?: string[];
      permissions: string[];
      proof?: FactorProof;
    }) => {
      const created = await api.post<User>('/v1/users', body);
      // The avatar is stored right after the user exists; a failure there
      // keeps the new user and says so (the Details tab can set it again).
      let avatarError: unknown = null;
      if (avatar != null) {
        try {
          await applyAvatarChoice(userAvatarPath(created.id, null), avatar);
        } catch (err) {
          avatarError = err;
        }
      }
      return { created, avatarError };
    },
    onError: (err: unknown) => {
      setProofFailure(proofRejection(err));
    },
    onSuccess: ({ created, avatarError }) => {
      if (avatarError != null) {
        toast({
          title: t('avatar.applyFailed'),
          description: getErrorMessage(avatarError, t, 'avatar.saveFailed'),
          variant: 'destructive',
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      createdToast();
      void navigate(`/users/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!email.trim()) errors.email = t('validation.required');
    if (!firstName.trim()) errors.firstName = t('validation.required');
    if (!lastName.trim()) errors.lastName = t('validation.required');
    if (!roleId) errors.roleId = t('validation.selectRequired');
    if (roleId && accessKind === 'sites' && selectedSiteIds.length === 0) {
      errors.siteIds = t('users.siteAccessRequired');
    }
    return errors;
  }

  const errors = { ...getValidationErrors(), ...getApiErrorFieldDetails(createMutation.error) };

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    if (needsProof && proof == null) return;
    // One request: the user with its final permissions, and one proof (a TOTP code works once).
    createMutation.mutate({
      email,
      roleId,
      ...userAccessBody(accessKind, selectedSiteIds, selectedFleetIds),
      permissions: selectedPermissions,
      ...(needsProof && proof != null ? { proof } : {}),
      ...(firstName.trim() !== '' ? { firstName } : {}),
      ...(lastName.trim() !== '' ? { lastName } : {}),
      ...(phone.trim() !== '' ? { phone } : {}),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/users" />
        <h1 className="text-2xl font-bold md:text-3xl">{t('users.createUser')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="grid gap-6">
            <PendingAvatarField
              choice={avatar}
              onChange={setAvatar}
              firstName={firstName}
              lastName={lastName}
              description={t('avatar.editDescriptionUser')}
              hint={t('avatar.savedWithNewAccount')}
            />
            <div className="space-y-2">
              <Label htmlFor="user-email" className="leading-6">
                {t('common.email')}
              </Label>
              <Input
                id="user-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                className={hasSubmitted && errors.email ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.email && (
                <p className="text-sm text-destructive">{errors.email}</p>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div className="space-y-2">
                <Label htmlFor="user-first" className="leading-6">
                  {t('users.firstName')}
                </Label>
                <Input
                  id="user-first"
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                  }}
                  className={hasSubmitted && errors.firstName ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.firstName && (
                  <p className="text-sm text-destructive">{errors.firstName}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="user-last" className="leading-6">
                  {t('users.lastName')}
                </Label>
                <Input
                  id="user-last"
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value);
                  }}
                  className={hasSubmitted && errors.lastName ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.lastName && (
                  <p className="text-sm text-destructive">{errors.lastName}</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-phone" className="leading-6">
                {t('users.phone')}
              </Label>
              <Input
                id="user-phone"
                type="tel"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                }}
                placeholder={t('users.phonePlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-role" className="leading-6">
                {t('users.role')}
              </Label>
              <Select
                id="user-role"
                value={roleId}
                onChange={(e) => {
                  setRoleId(e.target.value);
                }}
                className={hasSubmitted && errors.roleId ? 'border-destructive' : ''}
              >
                <option value="">{t('users.selectRole')}</option>
                {offeredRoles(roles ?? [], canGrantAllSites && fleetEnabled).map((role) => (
                  <option key={role.id} value={role.id}>
                    {roleLabel(role.name, t)}
                  </option>
                ))}
              </Select>
              {hasSubmitted && errors.roleId && (
                <p className="text-sm text-destructive">{errors.roleId}</p>
              )}
            </div>
            {roleId !== '' && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">{t('users.permissions')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground mb-4">
                    {t('users.permissionsDescription')}
                  </p>
                  <PermissionEditor
                    value={selectedPermissions}
                    onChange={setSelectedPermissions}
                    allowed={fleetManagerRole ? FLEET_USER_PERMISSIONS : undefined}
                  />
                </CardContent>
              </Card>
            )}
            <UserAccessField
              idPrefix="create"
              kind={accessKind}
              onKindChange={setAccessKind}
              siteIds={selectedSiteIds}
              onSiteIdsChange={setSelectedSiteIds}
              fleetIds={selectedFleetIds}
              onFleetIdsChange={setSelectedFleetIds}
              canGrantAllSites={canGrantAllSites}
              roleName={selectedRoleName}
              error={hasSubmitted ? errors.siteIds : undefined}
            />
            {needsProof && (
              <FactorProofField
                idPrefix="user-create-proof"
                kinds={proofKinds}
                codeMethod={mfaStatus?.mfaMethod ?? null}
                description={t('users.adminProofHint')}
                onChange={setProof}
                rejection={proofFailure}
                showMissing={hasSubmitted}
              />
            )}
            {createMutation.isError && (
              <p className="text-sm text-destructive" role="alert">
                {getErrorMessage(createMutation.error, t)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate('/users');
                }}
              />
              <CreateButton
                label={t('common.create')}
                type="submit"
                disabled={createMutation.isPending}
              />
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
