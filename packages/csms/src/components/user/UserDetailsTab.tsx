// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EditButton } from '@/components/edit-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth, useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import type { AvatarData } from '@/components/AccountAvatar';
import { AvatarField } from '@/components/avatar/AvatarField';
import { useToast } from '@/components/ui/toast';
import { applyAvatarChoice, userAvatarPath, type AvatarChoice } from '@/lib/avatar';
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { getErrorMessage } from '@/lib/error-message';
import { isAdminEquivalent } from '@evtivity/lib/admin-equivalent';
import { permissionCatalog } from '@evtivity/lib/permissions';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';

export interface UserDetailUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  roleId: string;
  isActive: boolean;
  hasAllSiteAccess: boolean;
  siteIds: string[];
  /** The user's permissions (GET /v1/users/:id). */
  permissions?: string[];
  mfaEnabled?: boolean;
  mfaMethod?: string | null;
  /** 'sso' for an account an SSO sign-in created. */
  authSource?: 'password' | 'sso';
  /** SSO may link this password account at its next sign-in. */
  ssoLinkAllowed?: boolean;
  /** The account is bound to its identity provider user. */
  ssoLinked?: boolean;
  /** The user's avatar (GET /v1/users/:id). */
  avatar?: AvatarData | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserRole {
  id: string;
  name: string;
}

interface Site {
  id: string;
  name: string;
}

export interface UserDetailsTabProps {
  user: UserDetailUser;
  userId: string;
  roles: UserRole[] | undefined;
  /**
   * False when the user holds permissions the operator lacks: only the name
   * can change (the API refuses email, status, role, site access and phone
   * changes).
   */
  canAdminister: boolean;
}

export function UserDetailsTab({
  user,
  userId,
  roles,
  canAdminister,
}: UserDetailsTabProps): React.JSX.Element {
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const canGrantAllSites = useHasAllSiteAccess();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const ownUserId = useAuth((s) => s.user?.id);
  // Everyone edits the own avatar; another user's needs users:write. An avatar
  // grants no access, so it is a profile field like the name (no proof).
  const isSelf = ownUserId === userId;
  const canEditAvatar = useHasPermission('users:write') || isSelf;

  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [hasAllSiteAccess, setHasAllSiteAccess] = useState(false);
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);
  const [hasSubmittedEdit, setHasSubmittedEdit] = useState(false);
  // Moving an admin-equivalent user's email or phone, or reactivating one, takes a
  // fresh proof of the signed-in account.
  const { data: mfaStatus } = useMfaStatus();
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const [proofRound, setProofRound] = useState(0);
  const emailChanged =
    editing && canAdminister && email.trim().toLowerCase() !== user.email.toLowerCase();
  // A role change replaces the permissions with the role defaults: a grant when the
  // defaults hold a permission the user lacks.
  const held = user.permissions ?? [];
  const newRoleName = roles?.find((r) => r.id === roleId)?.name;
  const roleDefaults =
    editing && canAdminister && roleId !== user.roleId && newRoleName != null
      ? permissionCatalog.defaultsFor(newRoleName)
      : null;
  const roleGrants = roleDefaults != null && roleDefaults.some((p) => !held.includes(p));
  const phoneChanged = editing && canAdminister && phone.trim() !== (user.phone ?? '');
  const reactivated = editing && canAdminister && isActive && !user.isActive;
  const accountOfAdmin =
    (emailChanged || phoneChanged || reactivated) &&
    (isAdminEquivalent(held) || isAdminEquivalent(roleDefaults ?? held));
  const needsProof = proofKinds.length > 0 && (roleGrants || accountOfAdmin);

  const { data: sitesData } = useQuery({
    queryKey: ['sites-for-select'],
    queryFn: () => api.get<{ data: Site[] }>('/v1/sites?limit=100'),
    enabled: editing,
  });
  const sitesList = sitesData?.data ?? [];

  const updateMutation = useMutation({
    mutationFn: (body: {
      email?: string;
      firstName?: string;
      lastName?: string;
      phone?: string | null;
      roleId?: string;
      isActive?: boolean;
      hasAllSiteAccess?: boolean;
      siteIds?: string[];
      proof?: FactorProof;
    }) => api.patch<UserDetailUser>(`/v1/users/${userId}`, body),
    onError: (err: unknown) => {
      setProofFailure(proofRejection(err));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditing(false);
      setHasSubmittedEdit(false);
    },
  });

  function startEdit(): void {
    setEmail(user.email);
    setFirstName(user.firstName ?? '');
    setLastName(user.lastName ?? '');
    setPhone(user.phone ?? '');
    setRoleId(user.roleId);
    setIsActive(user.isActive);
    setHasAllSiteAccess(user.hasAllSiteAccess);
    setSelectedSiteIds(user.siteIds);
    setProof(null);
    setProofFailure(null);
    setProofRound((n) => n + 1);
    updateMutation.reset();
    setEditing(true);
  }

  function getEditValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (canAdminister && email.trim() === '') {
      errors.email = t('validation.required');
    } else if (canAdminister && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.email = t('validation.email');
    }
    if (roleId.trim() === '') {
      errors.roleId = t('validation.selectRequired');
    }
    // A site-restricted operator cannot leave a user without a site: the
    // user would drop out of its view (the API answers 400 INVALID_SITE_IDS).
    if (canAdminister && !canGrantAllSites && selectedSiteIds.length === 0) {
      errors.siteIds = t('users.siteAccessRequired');
    }
    return errors;
  }

  const editErrors = getEditValidationErrors();

  /** The avatar is stored at once, apart from the form's Save. */
  async function saveAvatar(choice: AvatarChoice): Promise<void> {
    await applyAvatarChoice(userAvatarPath(userId, ownUserId), choice);
    toast({
      title: t(choice.kind === 'remove' ? 'avatar.removed' : 'avatar.saved'),
      variant: 'success',
    });
    // The user page and list, and for the own account the sidebar user menu.
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  }

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmittedEdit(true);
    if (Object.keys(editErrors).length > 0) return;
    if (!canAdminister) {
      updateMutation.mutate({ firstName, lastName });
      return;
    }
    if (needsProof && proof == null) return;
    const trimmedEmail = email.trim();
    updateMutation.mutate({
      ...(needsProof && proof != null ? { proof } : {}),
      ...(trimmedEmail.toLowerCase() !== user.email.toLowerCase() ? { email: trimmedEmail } : {}),
      firstName,
      lastName,
      phone: phone.trim() || null,
      roleId,
      isActive,
      hasAllSiteAccess,
      siteIds: hasAllSiteAccess ? [] : selectedSiteIds,
    });
  }

  function getRoleName(rid: string): string {
    return roles?.find((r) => r.id === rid)?.name ?? rid;
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('common.details')}</CardTitle>
        {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form onSubmit={handleSave} noValidate className="grid gap-6">
            <AvatarField
              avatar={user.avatar}
              firstName={user.firstName}
              lastName={user.lastName}
              {...(isSelf ? {} : { description: t('avatar.editDescriptionUser') })}
              {...(canEditAvatar ? { onSave: saveAvatar } : {})}
            />
            <div className="space-y-2">
              <Label htmlFor="edit-email" className="leading-6">
                {t('common.email')}
              </Label>
              {canAdminister ? (
                <>
                  <Input
                    id="edit-email"
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                    }}
                    className={hasSubmittedEdit && editErrors.email ? 'border-destructive' : ''}
                  />
                  {hasSubmittedEdit && editErrors.email && (
                    <p className="text-sm text-destructive">{editErrors.email}</p>
                  )}
                </>
              ) : (
                <Input id="edit-email" value={user.email} disabled />
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-first" className="leading-6">
                  {t('users.firstName')}
                </Label>
                <Input
                  id="edit-first"
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-last" className="leading-6">
                  {t('users.lastName')}
                </Label>
                <Input
                  id="edit-last"
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value);
                  }}
                />
              </div>
            </div>
            {!canAdminister && (
              <p className="text-sm text-muted-foreground">{t('users.nameOnlyNotice')}</p>
            )}
            {canAdminister && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="edit-phone" className="leading-6">
                    {t('users.phone')}
                  </Label>
                  <Input
                    id="edit-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => {
                      setPhone(e.target.value);
                    }}
                    placeholder={t('users.phonePlaceholder')}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-role" className="leading-6">
                    {t('users.role')}
                  </Label>
                  <Select
                    id="edit-role"
                    value={roleId}
                    onChange={(e) => {
                      setRoleId(e.target.value);
                    }}
                    className={hasSubmittedEdit && editErrors.roleId ? 'border-destructive' : ''}
                  >
                    <option value="">{t('users.selectRole')}</option>
                    {roles?.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </Select>
                  {hasSubmittedEdit && editErrors.roleId && (
                    <p className="text-sm text-destructive">{editErrors.roleId}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="edit-active"
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => {
                      setIsActive(e.target.checked);
                    }}
                    className="h-4 w-4 rounded border-input"
                  />
                  <Label htmlFor="edit-active">{t('common.active')}</Label>
                </div>
                <div className="space-y-2">
                  <Label className="leading-6">{t('users.siteAccess')}</Label>
                  {/* Only an operator with access to every site may grant it. */}
                  {canGrantAllSites && (
                    <>
                      <div className="flex items-center gap-2">
                        <input
                          id="edit-all-sites"
                          type="checkbox"
                          checked={hasAllSiteAccess}
                          onChange={(e) => {
                            setHasAllSiteAccess(e.target.checked);
                            if (e.target.checked) setSelectedSiteIds([]);
                          }}
                          className="h-4 w-4 rounded border-input"
                        />
                        <Label htmlFor="edit-all-sites">{t('users.allSites')}</Label>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t('users.allSitesDescription')}
                      </p>
                    </>
                  )}
                  {!hasAllSiteAccess && (
                    <div
                      className={`max-h-48 overflow-y-auto rounded-md border p-3 space-y-2 ${
                        hasSubmittedEdit && editErrors.siteIds
                          ? 'border-destructive'
                          : 'border-border'
                      }`}
                    >
                      {sitesList.length === 0 && (
                        <p className="text-xs text-muted-foreground">n/a</p>
                      )}
                      {sitesList.map((site) => (
                        <div key={site.id} className="flex items-center gap-2">
                          <input
                            id={`edit-site-${site.id}`}
                            type="checkbox"
                            checked={selectedSiteIds.includes(site.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedSiteIds((prev) => [...prev, site.id]);
                              } else {
                                setSelectedSiteIds((prev) => prev.filter((sid) => sid !== site.id));
                              }
                            }}
                            className="h-4 w-4 rounded border-input"
                          />
                          <Label htmlFor={`edit-site-${site.id}`}>{site.name}</Label>
                        </div>
                      ))}
                    </div>
                  )}
                  {hasSubmittedEdit && editErrors.siteIds && (
                    <p className="text-xs text-destructive">{editErrors.siteIds}</p>
                  )}
                </div>
              </>
            )}
            {needsProof && (
              <FactorProofField
                key={`email-${String(proofRound)}`}
                idPrefix="user-email-proof"
                kinds={proofKinds}
                codeMethod={mfaStatus?.mfaMethod ?? null}
                description={t(roleGrants ? 'users.roleProofHint' : 'users.emailProofHint')}
                onChange={setProof}
                rejection={proofFailure}
                showMissing={hasSubmittedEdit}
              />
            )}
            {updateMutation.isError && (
              <p className="text-sm text-destructive" role="alert">
                {getErrorMessage(updateMutation.error, t)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  setEditing(false);
                  setHasSubmittedEdit(false);
                }}
              />
              <SaveButton isPending={updateMutation.isPending} />
            </div>
          </form>
        ) : (
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('common.email')}</dt>
              <dd className="font-medium">{user.email}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('common.name')}</dt>
              <dd className="font-medium">
                {[user.firstName, user.lastName].filter(Boolean).join(' ') || '-'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('users.phone')}</dt>
              <dd className="font-medium">{user.phone ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('users.role')}</dt>
              <dd className="font-medium">
                <Badge variant="secondary">{getRoleName(user.roleId)}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('common.status')}</dt>
              <dd className="font-medium">
                <Badge variant={user.isActive ? 'default' : 'outline'}>
                  {user.isActive ? t('common.active') : t('common.inactive')}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('users.siteAccess')}</dt>
              <dd className="font-medium">
                {user.hasAllSiteAccess
                  ? t('users.allSites')
                  : t('users.sitesCount', { count: user.siteIds.length })}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('users.lastLogin')}</dt>
              <dd className="font-medium">
                {user.lastLoginAt != null
                  ? formatDateTime(user.lastLoginAt, timezone)
                  : t('common.never')}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('common.created')}</dt>
              <dd className="font-medium">{formatDateTime(user.createdAt, timezone)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('common.lastUpdated')}</dt>
              <dd className="font-medium">{formatDateTime(user.updatedAt, timezone)}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
