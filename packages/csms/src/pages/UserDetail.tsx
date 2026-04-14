// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { RefreshCw } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { CopyableId } from '@/components/copyable-id';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PermissionEditor } from '@/components/PermissionEditor';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  roleId: string;
  isActive: boolean;
  hasAllSiteAccess: boolean;
  siteIds: string[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Site {
  id: string;
  name: string;
}

interface Role {
  id: string;
  name: string;
}

export function UserDetail(): React.JSX.Element {
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentUserId = useAuth((s) => s.user?.id);

  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [hasAllSiteAccess, setHasAllSiteAccess] = useState(false);
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);

  const [editingPermissions, setEditingPermissions] = useState(false);
  const [editPermissions, setEditPermissions] = useState<string[]>([]);

  const [newPassword, setNewPassword] = useState('');
  const [hasSubmittedEdit, setHasSubmittedEdit] = useState(false);
  const [hasSubmittedPassword, setHasSubmittedPassword] = useState(false);

  const isOwnUser = id === currentUserId;

  // Redirect to profile page when viewing own user
  useEffect(() => {
    if (isOwnUser) {
      void navigate('/profile', { replace: true });
    }
  }, [isOwnUser, navigate]);

  const { data: user, isLoading } = useQuery({
    queryKey: ['users', id],
    queryFn: () => api.get<User>(`/v1/users/${id ?? ''}`),
    enabled: id != null,
  });

  const { data: roles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<Role[]>('/v1/roles'),
  });

  const { data: userPermissions = [] } = useQuery({
    queryKey: ['users', id, 'permissions'],
    queryFn: () => api.get<string[]>(`/v1/users/${id ?? ''}/permissions`),
    enabled: id != null,
  });

  const { data: sitesData } = useQuery({
    queryKey: ['sites-for-select'],
    queryFn: () => api.get<{ data: Site[] }>('/v1/sites?limit=100'),
    enabled: editing,
  });
  const sitesList = sitesData?.data ?? [];

  const updateMutation = useMutation({
    mutationFn: (body: {
      firstName?: string;
      lastName?: string;
      phone?: string | null;
      roleId?: string;
      isActive?: boolean;
      hasAllSiteAccess?: boolean;
      siteIds?: string[];
    }) => api.patch<User>(`/v1/users/${id ?? ''}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users', id] });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditing(false);
      setHasSubmittedEdit(false);
    },
  });

  const permissionsMutation = useMutation({
    mutationFn: (perms: string[]) =>
      api.put<string[]>(`/v1/users/${id ?? ''}/permissions`, { permissions: perms }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users', id, 'permissions'] });
      setEditingPermissions(false);
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: (body: { password: string }) =>
      api.post<{ success: boolean }>(`/v1/users/${id ?? ''}/reset-password`, body),
    onSuccess: () => {
      setNewPassword('');
      setHasSubmittedPassword(false);
    },
  });

  function startEdit(): void {
    if (user == null) return;
    setFirstName(user.firstName ?? '');
    setLastName(user.lastName ?? '');
    setPhone(user.phone ?? '');
    setRoleId(user.roleId);
    setIsActive(user.isActive);
    setHasAllSiteAccess(user.hasAllSiteAccess);
    setSelectedSiteIds(user.siteIds);
    setEditing(true);
  }

  function startEditPermissions(): void {
    setEditPermissions([...userPermissions]);
    setEditingPermissions(true);
  }

  function getEditValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (roleId.trim() === '') {
      errors.roleId = t('validation.selectRequired');
    }
    return errors;
  }

  function getPasswordValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (newPassword.trim() === '') {
      errors.newPassword = t('validation.required');
    } else if (newPassword.length < 8) {
      errors.newPassword = t('validation.minLength', { min: 8 });
    }
    return errors;
  }

  const editErrors = getEditValidationErrors();
  const passwordErrors = getPasswordValidationErrors();

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmittedEdit(true);
    if (Object.keys(editErrors).length > 0) return;
    updateMutation.mutate({
      firstName,
      lastName,
      phone: phone.trim() || null,
      roleId,
      isActive,
      hasAllSiteAccess,
      siteIds: hasAllSiteAccess ? [] : selectedSiteIds,
    });
  }

  function handleSavePermissions(): void {
    permissionsMutation.mutate(editPermissions);
  }

  function handleResetPassword(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmittedPassword(true);
    if (Object.keys(passwordErrors).length > 0) return;
    resetPasswordMutation.mutate({ password: newPassword });
  }

  function generateRandomPassword(): string {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => chars[b % chars.length]).join('');
  }

  function getRoleName(rid: string): string {
    return roles?.find((r) => r.id === rid)?.name ?? rid;
  }

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (user == null) {
    return <p className="text-destructive">{t('users.userNotFound')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/users" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{user.email}</h1>
          <CopyableId id={user.id} />
        </div>
        <Badge variant={user.isActive ? 'default' : 'outline'}>
          {user.isActive ? t('common.active') : t('common.inactive')}
        </Badge>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
        </CardHeader>
        <CardContent>
          {editing ? (
            <form onSubmit={handleSave} noValidate className="grid gap-6">
              <div className="space-y-2">
                <Label htmlFor="edit-email">{t('common.email')}</Label>
                <Input id="edit-email" value={user.email} disabled />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-first">{t('users.firstName')}</Label>
                  <Input
                    id="edit-first"
                    value={firstName}
                    onChange={(e) => {
                      setFirstName(e.target.value);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-last">{t('users.lastName')}</Label>
                  <Input
                    id="edit-last"
                    value={lastName}
                    onChange={(e) => {
                      setLastName(e.target.value);
                    }}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-phone">{t('users.phone')}</Label>
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
                <Label htmlFor="edit-role">{t('users.role')}</Label>
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
                <Label>{t('users.siteAccess')}</Label>
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
                <p className="text-xs text-muted-foreground">{t('users.allSitesDescription')}</p>
                {!hasAllSiteAccess && (
                  <div className="max-h-48 overflow-y-auto rounded-md border border-border p-3 space-y-2">
                    {sitesList.length === 0 && <p className="text-xs text-muted-foreground">--</p>}
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
              </div>
              <div className="flex gap-2">
                <SaveButton isPending={updateMutation.isPending} />
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                    setHasSubmittedEdit(false);
                  }}
                />
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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('users.permissions')}</CardTitle>
          {!editingPermissions && (
            <EditButton label={t('common.edit')} onClick={startEditPermissions} />
          )}
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">{t('users.writeImpliesRead')}</p>
          {userPermissions.length === 0 && !editingPermissions ? (
            <p className="text-sm text-muted-foreground">{t('users.noPermissions')}</p>
          ) : (
            <div className="space-y-4">
              <PermissionEditor
                value={editingPermissions ? editPermissions : userPermissions}
                onChange={setEditPermissions}
                disabled={!editingPermissions}
              />
              {editingPermissions && (
                <div className="flex gap-2">
                  <SaveButton
                    isPending={permissionsMutation.isPending}
                    onClick={handleSavePermissions}
                  />
                  <CancelButton
                    onClick={() => {
                      setEditingPermissions(false);
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('users.resetPassword')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            {t('users.resetPasswordDescription')}
          </p>
          <form onSubmit={handleResetPassword} noValidate className="grid gap-6">
            <div className="space-y-2">
              <Label htmlFor="new-password">{t('users.newPassword')}</Label>
              <div className="flex gap-2">
                <PasswordInput
                  id="new-password"
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                  }}
                  className={
                    hasSubmittedPassword && passwordErrors.newPassword ? 'border-destructive' : ''
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setNewPassword(generateRandomPassword());
                  }}
                >
                  <RefreshCw className="h-4 w-4" />
                  {t('users.generatePassword')}
                </Button>
              </div>
              {hasSubmittedPassword && passwordErrors.newPassword && (
                <p className="text-sm text-destructive">{passwordErrors.newPassword}</p>
              )}
            </div>
            <Button type="submit" className="w-fit" disabled={resetPasswordMutation.isPending}>
              {t('users.resetPassword')}
            </Button>
            {resetPasswordMutation.isSuccess && (
              <p className="text-sm text-success">{t('users.passwordResetSuccess')}</p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
