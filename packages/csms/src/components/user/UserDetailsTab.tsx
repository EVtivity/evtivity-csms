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
import { api } from '@/lib/api';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

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
}

export function UserDetailsTab({ user, userId, roles }: UserDetailsTabProps): React.JSX.Element {
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [hasAllSiteAccess, setHasAllSiteAccess] = useState(false);
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);
  const [hasSubmittedEdit, setHasSubmittedEdit] = useState(false);

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
    }) => api.patch<UserDetailUser>(`/v1/users/${userId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditing(false);
      setHasSubmittedEdit(false);
    },
  });

  function startEdit(): void {
    setFirstName(user.firstName ?? '');
    setLastName(user.lastName ?? '');
    setPhone(user.phone ?? '');
    setRoleId(user.roleId);
    setIsActive(user.isActive);
    setHasAllSiteAccess(user.hasAllSiteAccess);
    setSelectedSiteIds(user.siteIds);
    setEditing(true);
  }

  function getEditValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (roleId.trim() === '') {
      errors.roleId = t('validation.selectRequired');
    }
    return errors;
  }

  const editErrors = getEditValidationErrors();

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
                  {sitesList.length === 0 && <p className="text-xs text-muted-foreground">n/a</p>}
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
