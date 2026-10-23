// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { permissionCatalog } from '@evtivity/lib/permissions';
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
  const canGrantAllSites = useHasAllSiteAccess();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
  const [hasAllSiteAccess, setHasAllSiteAccess] = useState(false);
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [hasSubmitted, setHasSubmitted] = useState(false);
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

  const { data: sitesData } = useQuery({
    queryKey: ['sites-for-select'],
    queryFn: () => api.get<{ data: Site[] }>('/v1/sites?limit=100'),
  });
  const sitesList = sitesData?.data ?? [];

  // When role changes, reset permissions to the defaults the server gives that role
  useEffect(() => {
    if (roleId === '' || roles == null) return;
    const selectedRole = roles.find((r) => r.id === roleId);
    if (selectedRole == null) return;
    setSelectedPermissions(permissionCatalog.defaultsFor(selectedRole.name));
  }, [roleId, roles]);

  const createMutation = useMutation({
    mutationFn: async (body: {
      email: string;
      firstName?: string;
      lastName?: string;
      roleId: string;
      hasAllSiteAccess: boolean;
      siteIds?: string[];
      permissions: string[];
      proof?: FactorProof;
    }) => api.post<User>('/v1/users', body),
    onError: (err: unknown) => {
      setProofFailure(proofRejection(err));
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
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
      hasAllSiteAccess,
      permissions: selectedPermissions,
      ...(needsProof && proof != null ? { proof } : {}),
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
              <Label className="leading-6">{t('users.siteAccess')}</Label>
              {/* Only an operator with access to every site may grant it. */}
              {canGrantAllSites && (
                <>
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
                </>
              )}
              {!hasAllSiteAccess && (
                <div
                  className={`max-h-48 overflow-y-auto rounded-md border p-3 space-y-2 ${
                    hasSubmitted && errors.siteIds ? 'border-destructive' : 'border-border'
                  }`}
                >
                  {sitesList.length === 0 && <p className="text-xs text-muted-foreground">n/a</p>}
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
