// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PermissionEditor } from '@/components/PermissionEditor';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

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
}

interface Site {
  id: string;
  name: string;
}

export function UserCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
  const [hasAllSiteAccess, setHasAllSiteAccess] = useState(false);
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data: roles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<Role[]>('/v1/roles'),
  });

  const { data: sitesData } = useQuery({
    queryKey: ['sites-for-select'],
    queryFn: () => api.get<{ data: Site[] }>('/v1/sites?limit=100'),
  });
  const sitesList = sitesData?.data ?? [];

  // Fetch role defaults for permission pre-population
  const { data: roleDefaults } = useQuery({
    queryKey: ['role-defaults'],
    queryFn: async () => {
      const groups = await api.get<{ label: string; permissions: string[] }[]>('/v1/permissions');
      const allPerms = groups.flatMap((g) => g.permissions);
      // Admin gets all, operator gets operational subset
      // We replicate the backend logic here
      const adminPerms = [...allPerms];
      const operatorPerms = allPerms.filter(
        (p) => !p.startsWith('settings.') && p !== 'users:write',
      );
      const viewerPerms = allPerms.filter((p) => p.endsWith(':read') && !p.startsWith('settings.'));
      return { admin: adminPerms, operator: operatorPerms, viewer: viewerPerms };
    },
  });

  // When role changes, reset permissions to that role's defaults
  useEffect(() => {
    if (roleId === '' || roles == null || roleDefaults == null) return;
    const selectedRole = roles.find((r) => r.id === roleId);
    if (selectedRole == null) return;
    const defaults =
      selectedRole.name === 'admin'
        ? roleDefaults.admin
        : selectedRole.name === 'viewer'
          ? roleDefaults.viewer
          : roleDefaults.operator;
    setSelectedPermissions(defaults);
  }, [roleId, roles, roleDefaults]);

  const createMutation = useMutation({
    mutationFn: async (body: {
      email: string;
      firstName?: string;
      lastName?: string;
      roleId: string;
      hasAllSiteAccess: boolean;
      siteIds?: string[];
    }) => {
      const created = await api.post<User>('/v1/users', body);
      // After user creation, set permissions
      if (selectedPermissions.length > 0) {
        await api.put(`/v1/users/${created.id}/permissions`, {
          permissions: selectedPermissions,
        });
      }
      return created;
    },
    onSuccess: (created) => {
      void navigate(`/users/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!email.trim()) errors.email = t('validation.required');
    if (!firstName.trim()) errors.firstName = t('validation.required');
    if (!lastName.trim()) errors.lastName = t('validation.required');
    if (!roleId) errors.roleId = t('validation.selectRequired');
    if (!hasAllSiteAccess && selectedSiteIds.length === 0) {
      errors.siteIds = t('users.siteAccessRequired');
    }
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    createMutation.mutate({
      email,
      roleId,
      hasAllSiteAccess,
      ...(firstName.trim() !== '' ? { firstName } : {}),
      ...(lastName.trim() !== '' ? { lastName } : {}),
      ...(phone.trim() !== '' ? { phone } : {}),
      ...(hasAllSiteAccess ? {} : { siteIds: selectedSiteIds }),
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
            <div className="space-y-2">
              <Label htmlFor="user-email">{t('common.email')}</Label>
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="user-first">{t('users.firstName')}</Label>
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
                <Label htmlFor="user-last">{t('users.lastName')}</Label>
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
              <Label htmlFor="user-phone">{t('users.phone')}</Label>
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
              <Label htmlFor="user-role">{t('users.role')}</Label>
              <Select
                id="user-role"
                value={roleId}
                onChange={(e) => {
                  setRoleId(e.target.value);
                }}
                className={hasSubmitted && errors.roleId ? 'border-destructive' : ''}
              >
                <option value="">{t('users.selectRole')}</option>
                {roles?.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
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
                  <PermissionEditor value={selectedPermissions} onChange={setSelectedPermissions} />
                </CardContent>
              </Card>
            )}
            <div className="space-y-2">
              <Label>{t('users.siteAccess')}</Label>
              <div className="flex items-center gap-2">
                <input
                  id="create-all-sites"
                  type="checkbox"
                  checked={hasAllSiteAccess}
                  onChange={(e) => {
                    setHasAllSiteAccess(e.target.checked);
                    if (e.target.checked) setSelectedSiteIds([]);
                  }}
                  className="h-4 w-4 rounded border-input"
                />
                <Label htmlFor="create-all-sites">{t('users.allSites')}</Label>
              </div>
              <p className="text-xs text-muted-foreground">{t('users.allSitesDescription')}</p>
              {!hasAllSiteAccess && (
                <div
                  className={`max-h-48 overflow-y-auto rounded-md border p-3 space-y-2 ${
                    hasSubmitted && errors.siteIds ? 'border-destructive' : 'border-border'
                  }`}
                >
                  {sitesList.length === 0 && <p className="text-xs text-muted-foreground">--</p>}
                  {sitesList.map((site) => (
                    <div key={site.id} className="flex items-center gap-2">
                      <input
                        id={`site-${site.id}`}
                        type="checkbox"
                        checked={selectedSiteIds.includes(site.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedSiteIds((prev) => [...prev, site.id]);
                          } else {
                            setSelectedSiteIds((prev) => prev.filter((id) => id !== site.id));
                          }
                        }}
                        className="h-4 w-4 rounded border-input"
                      />
                      <Label htmlFor={`site-${site.id}`}>{site.name}</Label>
                    </div>
                  ))}
                </div>
              )}
              {hasSubmitted && errors.siteIds && (
                <p className="text-xs text-destructive">{errors.siteIds}</p>
              )}
            </div>
            {createMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(createMutation.error, t)}</p>
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
