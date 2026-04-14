// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Check } from 'lucide-react';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';

interface Props {
  settings: Record<string, unknown> | undefined;
}

interface Role {
  id: string;
  name: string;
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div className="space-y-0.5">
        <Label>{label}</Label>
        {description != null && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => {
          onChange(!checked);
        }}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${checked ? 'bg-primary' : 'bg-muted'}`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
        />
      </button>
    </div>
  );
}

export function SecuritySsoSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState('');
  const [entryPoint, setEntryPoint] = useState('');
  const [issuer, setIssuer] = useState('evtivity-csms');
  const [cert, setCert] = useState('');
  const [certSet, setCertSet] = useState(false);
  const [autoProvision, setAutoProvision] = useState(false);
  const [defaultRoleId, setDefaultRoleId] = useState('');
  const [attrEmail, setAttrEmail] = useState('email');
  const [attrFirstName, setAttrFirstName] = useState('firstName');
  const [attrLastName, setAttrLastName] = useState('lastName');
  const [copied, setCopied] = useState(false);

  // Load SSO settings
  const { data: ssoSettings } = useQuery({
    queryKey: ['sso-settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/sso/settings'),
  });

  // Load roles for default role dropdown
  const { data: rolesData } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<Role[]>('/v1/roles'),
    enabled: autoProvision,
  });

  useEffect(() => {
    const s = ssoSettings ?? settings;
    if (s == null) return;
    setEnabled(s['sso.enabled'] === true);
    setProvider(typeof s['sso.provider'] === 'string' ? s['sso.provider'] : '');
    setEntryPoint(typeof s['sso.entryPoint'] === 'string' ? s['sso.entryPoint'] : '');
    setIssuer(typeof s['sso.issuer'] === 'string' ? s['sso.issuer'] : 'evtivity-csms');
    setAutoProvision(s['sso.autoProvision'] === true);
    setDefaultRoleId(typeof s['sso.defaultRoleId'] === 'string' ? s['sso.defaultRoleId'] : '');

    const certVal = s['sso.certEnc'];
    setCertSet(typeof certVal === 'string' && certVal !== '' && certVal !== '""');

    let mapping: Record<string, string> = {
      email: 'email',
      firstName: 'firstName',
      lastName: 'lastName',
    };
    const rawMapping = s['sso.attributeMapping'];
    if (typeof rawMapping === 'string') {
      try {
        mapping = JSON.parse(rawMapping) as Record<string, string>;
      } catch {
        // keep default
      }
    } else if (typeof rawMapping === 'object' && rawMapping !== null) {
      mapping = rawMapping as Record<string, string>;
    }
    setAttrEmail(mapping['email'] ?? 'email');
    setAttrFirstName(mapping['firstName'] ?? 'firstName');
    setAttrLastName(mapping['lastName'] ?? 'lastName');
  }, [ssoSettings, settings]);

  const mutation = useMutation({
    mutationFn: (vals: Record<string, unknown>) =>
      api.put<{ success: boolean }>('/v1/sso/settings', vals),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sso-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['security-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['security-public'] });
    },
  });

  function handleSave(): void {
    const payload: Record<string, unknown> = {
      enabled,
      provider,
      entryPoint,
      issuer,
      autoProvision,
      defaultRoleId,
      attributeMapping: {
        email: attrEmail,
        firstName: attrFirstName,
        lastName: attrLastName,
      },
    };
    // Only send cert when the user changed it
    if (cert !== '') {
      payload['cert'] = cert;
    }
    mutation.mutate(payload);
  }

  function handleCopyCallbackUrl(): void {
    const url = `${window.location.origin}/v1/auth/sso/callback`;
    void navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  }

  const callbackUrl = `${window.location.origin}/v1/auth/sso/callback`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.sso')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          noValidate
          className="space-y-4"
        >
          <p className="text-sm text-muted-foreground">{t('settings.ssoDescription')}</p>

          <ToggleRow label={t('settings.ssoEnabled')} checked={enabled} onChange={setEnabled} />

          {enabled && (
            <div className="grid gap-4">
              {/* Provider */}
              <div className="grid gap-2">
                <Label htmlFor="sso-provider-select">{t('settings.ssoProvider')}</Label>
                <Select
                  id="sso-provider-select"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value);
                  }}
                >
                  <option value="">--</option>
                  <option value="okta">Okta</option>
                  <option value="azure-ad">Azure AD</option>
                  <option value="google-workspace">Google Workspace</option>
                  <option value="custom">Custom</option>
                </Select>
              </div>

              {/* Entry Point URL */}
              <div className="grid gap-2">
                <Label htmlFor="sso-entry-point">{t('settings.ssoEntryPoint')}</Label>
                <Input
                  id="sso-entry-point"
                  value={entryPoint}
                  onChange={(e) => {
                    setEntryPoint(e.target.value);
                  }}
                  placeholder="https://your-idp.example.com/sso/saml"
                />
              </div>

              {/* SP Entity ID */}
              <div className="grid gap-2">
                <Label htmlFor="sso-issuer">{t('settings.ssoIssuer')}</Label>
                <Input
                  id="sso-issuer"
                  value={issuer}
                  onChange={(e) => {
                    setIssuer(e.target.value);
                  }}
                />
              </div>

              {/* IdP Certificate */}
              <div className="grid gap-2">
                <Label htmlFor="sso-cert">{t('settings.ssoCert')}</Label>
                <Textarea
                  id="sso-cert"
                  value={cert}
                  onChange={(e) => {
                    setCert(e.target.value);
                  }}
                  placeholder={certSet ? '********' : '-----BEGIN CERTIFICATE-----'}
                  rows={4}
                />
                {certSet && cert === '' && (
                  <p className="text-xs text-muted-foreground">{t('settings.ssoCertSet')}</p>
                )}
              </div>

              {/* ACS Callback URL (read-only) */}
              <div className="grid gap-2">
                <Label htmlFor="sso-callback-url">{t('settings.ssoCallbackUrl')}</Label>
                <div className="flex gap-2">
                  <Input id="sso-callback-url" value={callbackUrl} readOnly className="bg-muted" />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleCopyCallbackUrl}
                    aria-label="Copy"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                {copied && (
                  <p className="text-xs text-muted-foreground">{t('settings.ssoCopied')}</p>
                )}
              </div>

              {/* Auto-Provision */}
              <ToggleRow
                label={t('settings.ssoAutoProvision')}
                checked={autoProvision}
                onChange={setAutoProvision}
              />

              {/* Default Role */}
              {autoProvision && (
                <div className="grid gap-2">
                  <Label htmlFor="sso-default-role-select">{t('settings.ssoDefaultRole')}</Label>
                  <Select
                    id="sso-default-role-select"
                    value={defaultRoleId}
                    onChange={(e) => {
                      setDefaultRoleId(e.target.value);
                    }}
                  >
                    <option value="">--</option>
                    {(rolesData ?? []).map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              {/* Attribute Mapping */}
              <div className="grid gap-4">
                <Label className="text-base">{t('settings.ssoAttributeMapping')}</Label>
                <div className="grid gap-2">
                  <Label htmlFor="sso-attr-email">{t('settings.ssoAttrEmail')}</Label>
                  <Input
                    id="sso-attr-email"
                    value={attrEmail}
                    onChange={(e) => {
                      setAttrEmail(e.target.value);
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sso-attr-first-name">{t('settings.ssoAttrFirstName')}</Label>
                  <Input
                    id="sso-attr-first-name"
                    value={attrFirstName}
                    onChange={(e) => {
                      setAttrFirstName(e.target.value);
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sso-attr-last-name">{t('settings.ssoAttrLastName')}</Label>
                  <Input
                    id="sso-attr-last-name"
                    value={attrLastName}
                    onChange={(e) => {
                      setAttrLastName(e.target.value);
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          <SaveButton isPending={mutation.isPending} />

          {mutation.isSuccess && <p className="text-sm text-green-600">{t('settings.ssoSaved')}</p>}
          {mutation.isError && (
            <p className="text-sm text-destructive">{t('settings.ssoSaveFailed')}</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
