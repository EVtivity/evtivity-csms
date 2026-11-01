// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { isEditedField, useLoadedValues } from '@/hooks/use-loaded-values';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tryParseJson } from '@evtivity/lib/safe-json';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmToggle } from '@/components/ui/confirm-toggle';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { CopyButton } from '@/components/ui/copy-button';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';

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
        <Label className="leading-6">{label}</Label>
        {description != null && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <ConfirmToggle
        aria-label={label}
        label={label}
        size="lg"
        checked={checked}
        onCheckedChange={() => {
          onChange(!checked);
        }}
      />
    </div>
  );
}

interface ProtectedSsoFields {
  enabled: boolean;
  entryPoint: string;
  issuer: string;
  autoProvision: boolean;
  defaultRoleId: string;
  attributeMapping: Record<string, string>;
  allowedDomains: string[];
}

/** The SSO fields whose change needs a fresh proof (everything but the provider hint). */
function protectedFields(fields: ProtectedSsoFields): ProtectedSsoFields {
  return { ...fields, allowedDomains: [...fields.allowedDomains].sort() };
}

/** The allowed domains typed as a comma or space separated list, lowercased. */
function parseDomains(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d !== ''),
    ),
  ];
}

interface SsoForm {
  enabled: boolean;
  provider: string;
  entryPoint: string;
  issuer: string;
  /** The stored certificate when returned, else empty. */
  cert: string;
  autoProvision: boolean;
  defaultRoleId: string;
  attrEmail: string;
  attrFirstName: string;
  attrLastName: string;
  /** The allowed domains as typed (comma or space separated). */
  allowedDomains: string;
}

/** The form values of the stored SSO settings. */
function ssoFormFrom(s: Record<string, unknown> | undefined): SsoForm {
  const str = (key: string, fallback: string): string => {
    const v = s?.[key];
    return typeof v === 'string' ? v : fallback;
  };
  let mapping: Record<string, string> = {
    email: 'email',
    firstName: 'firstName',
    lastName: 'lastName',
  };
  const rawMapping = s?.['sso.attributeMapping'];
  if (typeof rawMapping === 'string') {
    // Invalid JSON keeps the default mapping.
    const parsed = tryParseJson(rawMapping);
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      mapping = parsed as Record<string, string>;
    }
  } else if (typeof rawMapping === 'object' && rawMapping !== null) {
    mapping = rawMapping as Record<string, string>;
  }
  const rawDomains = s?.['sso.allowedDomains'];
  const certVal = s?.['sso.certEnc'];
  return {
    enabled: s?.['sso.enabled'] === true,
    provider: str('sso.provider', ''),
    entryPoint: str('sso.entryPoint', ''),
    issuer: str('sso.issuer', 'evtivity-csms'),
    cert: typeof certVal === 'string' && certVal !== '""' ? certVal : '',
    autoProvision: s?.['sso.autoProvision'] === true,
    defaultRoleId: str('sso.defaultRoleId', ''),
    attrEmail: mapping['email'] ?? 'email',
    attrFirstName: mapping['firstName'] ?? 'firstName',
    attrLastName: mapping['lastName'] ?? 'lastName',
    allowedDomains: Array.isArray(rawDomains)
      ? rawDomains.map(String).join(', ')
      : typeof rawDomains === 'string'
        ? rawDomains
        : '',
  };
}

/** The fields of the form that the save sends and that need a proof to change. */
function protectedOf(form: SsoForm): ProtectedSsoFields {
  return {
    enabled: form.enabled,
    entryPoint: form.entryPoint,
    issuer: form.issuer,
    autoProvision: form.autoProvision,
    defaultRoleId: form.defaultRoleId,
    attributeMapping: {
      email: form.attrEmail,
      firstName: form.attrFirstName,
      lastName: form.attrLastName,
    },
    allowedDomains: parseDomains(form.allowedDomains),
  };
}

export function SecuritySsoSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // A signed-in session proves the account again to change who signs in as whom.
  const { data: mfaStatus } = useMfaStatus();
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const [proofAsked, setProofAsked] = useState(false);
  const [proofRound, setProofRound] = useState(0);
  const [saveError, setSaveError] = useState('');

  // Load SSO settings
  const { data: ssoSettings } = useQuery({
    queryKey: ['sso-settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/sso/settings'),
  });

  // A reload replaces the form only while it has no unsaved edits.
  const stored = ssoSettings ?? settings;
  const loaded = useMemo(() => ssoFormFrom(stored), [stored]);
  const [form, setForm, takeNextLoad, taken] = useLoadedValues<SsoForm>(loaded);
  const {
    enabled,
    provider,
    entryPoint,
    issuer,
    cert,
    autoProvision,
    defaultRoleId,
    attrEmail,
    attrFirstName,
    attrLastName,
    allowedDomains,
  } = form;
  function setField<K extends keyof SsoForm>(key: K): (value: SsoForm[K]) => void {
    return (value) => {
      setForm((f) => ({ ...f, [key]: value }));
    };
  }
  const setEnabled = setField('enabled');
  const setProvider = setField('provider');
  const setEntryPoint = setField('entryPoint');
  const setIssuer = setField('issuer');
  const setCert = setField('cert');
  const setAutoProvision = setField('autoProvision');
  const setDefaultRoleId = setField('defaultRoleId');
  const setAttrEmail = setField('attrEmail');
  const setAttrFirstName = setField('attrFirstName');
  const setAttrLastName = setField('attrLastName');
  const setAllowedDomains = setField('allowedDomains');
  // The saved values, to tell whether the form changed what needs a fresh proof.
  const certSet = loaded.cert !== '';
  // The certificate goes only when edited in this form, so one another user
  // rotated since this form loaded is not put back.
  const certEdited = cert !== '' && isEditedField(form, taken, 'cert');
  const loadedFields = JSON.stringify(protectedFields(protectedOf(loaded)));

  // Load roles for default role dropdown
  const { data: rolesData } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<Role[]>('/v1/roles'),
    enabled: autoProvision,
  });

  const mutation = useMutation({
    mutationFn: (vals: Record<string, unknown>) =>
      api.put<{ success: boolean }>('/v1/sso/settings', vals),
    onError: (err: unknown) => {
      setProofFailure(proofRejection(err));
      setSaveError(getErrorMessage(err, t, 'settings.ssoSaveFailed'));
    },
    onSuccess: () => {
      setSaveError('');
      setProof(null);
      setProofAsked(false);
      setProofFailure(null);
      setProofRound((n) => n + 1);
      void queryClient.invalidateQueries({ queryKey: ['sso-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['security-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['security-public'] });
    },
  });

  const current = protectedOf(form);
  const needsProof =
    proofKinds.length > 0 &&
    (JSON.stringify(protectedFields(current)) !== loadedFields || certEdited);

  function handleSave(): void {
    if (needsProof && proof == null) {
      setProofAsked(true);
      return;
    }
    const payload: Record<string, unknown> = { ...current, provider };
    if (certEdited) {
      payload['cert'] = cert;
    }
    if (needsProof && proof != null) payload['proof'] = proof;
    const sent = form;
    mutation.mutate(payload, {
      onSuccess: () => {
        takeNextLoad(sent);
      },
    });
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
                  <option value="">n/a</option>
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
                <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
                  <Input id="sso-callback-url" value={callbackUrl} readOnly className="bg-muted" />
                  <CopyButton value={callbackUrl} size="icon" />
                </div>
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
                    <option value="">n/a</option>
                    {(rolesData ?? []).map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              {/* Allowed Domains */}
              <div className="grid gap-2">
                <Label htmlFor="sso-allowed-domains">{t('settings.ssoAllowedDomains')}</Label>
                <Input
                  id="sso-allowed-domains"
                  value={allowedDomains}
                  onChange={(e) => {
                    setAllowedDomains(e.target.value);
                  }}
                  placeholder="example.com"
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.ssoAllowedDomainsHint')}
                </p>
              </div>

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
                <div className="grid justify-end gap-2">
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

          {needsProof && (
            <FactorProofField
              key={`sso-${String(proofRound)}`}
              idPrefix="sso-proof"
              kinds={proofKinds}
              codeMethod={mfaStatus?.mfaMethod ?? null}
              description={t('settings.ssoProofHint')}
              onChange={setProof}
              rejection={proofFailure}
              showMissing={proofAsked}
            />
          )}

          <SaveButton isPending={mutation.isPending} />

          {mutation.isSuccess && <p className="text-sm text-green-600">{t('settings.ssoSaved')}</p>}
          {mutation.isError && (
            <p className="text-sm text-destructive" role="alert">
              {saveError !== '' ? saveError : t('settings.ssoSaveFailed')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
