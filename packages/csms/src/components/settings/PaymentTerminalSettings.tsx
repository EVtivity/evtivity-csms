// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmToggle } from '@/components/ui/confirm-toggle';
import { ErrorState } from '@/components/ui/content-state';
import { IdText } from '@/components/ui/id-text';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SaveButton } from '@/components/save-button';
import { LoadingLogo } from '@/components/loading-logo';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';
import { PAYMENT_TERMINALS_KEY } from '@/components/payment-terminals/payment-terminal-types';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { defaultWebhookUrl } from './PaymentWebhookSetup';
import { StoredSecretInput } from './StoredSecretInput';
import { secretChange, type StoredSecret } from './stored-secret';

export const PAYMENT_TERMINAL_SETTINGS_KEY = ['payment-terminal-settings'] as const;

type IdtechEnvironment = 'sandbox' | 'production';

const MERCHANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `GET /v1/settings/payment-terminals`. */
export interface PaymentTerminalSettingsResponse {
  simulatedAvailable: boolean;
  webhookPath: string;
  idtech: {
    enabled: boolean;
    /** A recorded live sandbox run verified the ID TECH contract. */
    verified: boolean;
    environment: IdtechEnvironment;
    merchantId: string;
    /** Secrets come back only to users who also hold `settings.system:read`. */
    apiKey: string | null;
    apiKeyConfigured: boolean;
    apiSecret: string | null;
    apiSecretConfigured: boolean;
    webhookSecret: string | null;
    webhookSecretConfigured: boolean;
  };
}

type SecretField = 'apiKey' | 'apiSecret' | 'webhookSecret';
const SECRET_FIELDS: readonly SecretField[] = ['apiKey', 'apiSecret', 'webhookSecret'];
const NO_REMOVALS: Record<SecretField, boolean> = {
  apiKey: false,
  apiSecret: false,
  webhookSecret: false,
};

/** `POST /v1/settings/payment-terminals/:provider/test`. */
interface TestConnectionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Settings > Payment > Payment Terminals: the simulated provider status line
 * and the ID TECH Payment Service Gateway account.
 */
export function PaymentTerminalSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const canWrite = useHasPermission('settings.payment:write');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: PAYMENT_TERMINAL_SETTINGS_KEY,
    queryFn: () => api.get<PaymentTerminalSettingsResponse>('/v1/settings/payment-terminals'),
  });

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t('paymentTerminals.settings.description')}</p>
      {isLoading ? (
        <LoadingLogo size="inline" />
      ) : isError || data == null ? (
        <ErrorState
          onRetry={() => {
            void refetch();
          }}
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('paymentTerminals.settings.simulatedTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm" data-testid="terminal-simulated-status">
                {data.simulatedAvailable
                  ? t('paymentTerminals.settings.simulatedOn')
                  : t('paymentTerminals.settings.simulatedOff')}
              </p>
            </CardContent>
          </Card>
          <IdtechCard data={data} canWrite={canWrite} />
        </>
      )}
    </div>
  );
}

function IdtechCard({
  data,
  canWrite,
}: {
  data: PaymentTerminalSettingsResponse;
  canWrite: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // The GET returns a stored secret only to users who also hold this permission.
  const canReadSecrets = useHasPermission('settings.system:read');
  const idtech = data.idtech;
  const loaded = {
    enabled: idtech.enabled,
    environment: idtech.environment,
    merchantId: idtech.merchantId,
    apiKey: idtech.apiKey ?? '',
    apiSecret: idtech.apiSecret ?? '',
    webhookSecret: idtech.webhookSecret ?? '',
  };
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [removing, setRemoving] = useState(NO_REMOVALS);
  const [form, setForm] = useLoadedValues(loaded, () => {
    setHasSubmitted(false);
    setRemoving(NO_REMOVALS);
  });
  const secrets: Record<SecretField, StoredSecret> = {
    apiKey: { value: idtech.apiKey, configured: idtech.apiKeyConfigured },
    apiSecret: { value: idtech.apiSecret, configured: idtech.apiSecretConfigured },
    webhookSecret: { value: idtech.webhookSecret, configured: idtech.webhookSecretConfigured },
  };
  const secretChanges = Object.fromEntries(
    SECRET_FIELDS.map((field) => [
      field,
      secretChange(form[field], secrets[field], removing[field]),
    ]),
  ) as Record<SecretField, string | undefined>;
  const merchantId = form.merchantId.trim();
  const accountChanged =
    form.environment !== loaded.environment ||
    merchantId !== loaded.merchantId ||
    SECRET_FIELDS.some((field) => secretChanges[field] !== undefined);
  const dirty = form.enabled !== loaded.enabled || accountChanged;

  // A change of the environment, the merchant or a credential takes a fresh proof.
  const { data: mfaStatus } = useMfaStatus();
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const [proofAsked, setProofAsked] = useState(false);
  const [proofRound, setProofRound] = useState(0);
  const needsProof = proofKinds.length > 0 && accountChanged;

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put<{ success: boolean }>('/v1/settings/payment-terminals', body),
    onError: (err: unknown) => {
      setProofFailure(proofRejection(err));
    },
    onSuccess: () => {
      setProof(null);
      setProofAsked(false);
      setProofFailure(null);
      setProofRound((n) => n + 1);
      void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINAL_SETTINGS_KEY });
      void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINALS_KEY });
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api.post<TestConnectionResult>('/v1/settings/payment-terminals/idtech/test', {}),
  });

  const errors: Record<string, string> = {};
  if (merchantId !== '' && !MERCHANT_ID.test(merchantId)) {
    errors.merchantId = t('paymentTerminals.settings.merchantIdInvalid');
  } else if (form.enabled && merchantId === '') {
    errors.merchantId = t('validation.required');
  }
  const shown = hasSubmitted ? errors : {};

  function update(patch: Partial<typeof form>): void {
    setForm((current) => ({ ...current, ...patch }));
    save.reset();
    test.reset();
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0 || !dirty) return;
    if (needsProof && proof == null) {
      setProofAsked(true);
      return;
    }
    const body: Record<string, unknown> = {};
    const account: Record<string, unknown> = {};
    if (form.enabled !== loaded.enabled) account.enabled = form.enabled;
    if (form.environment !== loaded.environment) account.environment = form.environment;
    if (merchantId !== loaded.merchantId) account.merchantId = merchantId;
    for (const field of SECRET_FIELDS) {
      const value = secretChanges[field];
      if (value !== undefined) account[field] = value;
    }
    body.idtech = account;
    if (needsProof && proof != null) body.proof = proof;
    save.mutate(body, {
      onSuccess: () => {
        // The reload returns the secrets only to users who may read them: match what it will hold.
        setRemoving(NO_REMOVALS);
        setForm((current) => ({
          ...current,
          merchantId,
          apiKey: canReadSecrets && !removing.apiKey ? current.apiKey.trim() : '',
          apiSecret: canReadSecrets && !removing.apiSecret ? current.apiSecret.trim() : '',
          webhookSecret:
            canReadSecrets && !removing.webhookSecret ? current.webhookSecret.trim() : '',
        }));
      },
    });
  }

  const secretInput = (
    field: SecretField,
    labelKey:
      | 'paymentTerminals.settings.apiKey'
      | 'paymentTerminals.settings.apiSecret'
      | 'paymentTerminals.settings.webhookSecret',
    hintKey:
      | 'paymentTerminals.settings.apiKeyHint'
      | 'paymentTerminals.settings.apiSecretHint'
      | 'paymentTerminals.settings.webhookSecretHint',
  ): React.JSX.Element => (
    <div className="space-y-2">
      <Label htmlFor={`idtech-${field}`} className="leading-6">
        {t(labelKey)}
      </Label>
      <StoredSecretInput
        id={`idtech-${field}`}
        value={form[field]}
        onChange={(value) => {
          update({ [field]: value });
        }}
        secret={secrets[field]}
        removing={removing[field]}
        onRemovingChange={(value) => {
          setRemoving((current) => ({ ...current, [field]: value }));
          save.reset();
          test.reset();
        }}
        canWrite={canWrite}
        hint={t(hintKey)}
      />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('paymentTerminals.settings.idtechTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="space-y-4" data-testid="idtech-form">
          <p className="text-sm text-muted-foreground">
            {t('paymentTerminals.settings.idtechDescription')}
          </p>
          {!idtech.verified && (
            <Alert variant="warning" data-testid="idtech-unverified">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{t('paymentTerminals.settings.unverified')}</AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-3">
            <ConfirmToggle
              id="idtech-enabled"
              checked={form.enabled}
              disabled={!canWrite}
              aria-label={t('paymentTerminals.settings.idtechEnabled')}
              label={t('paymentTerminals.settings.idtechEnabled')}
              offDescription={t('paymentTerminals.settings.idtechOffDescription')}
              onCheckedChange={(checked) => {
                update({ enabled: checked });
              }}
            />
            <Label htmlFor="idtech-enabled">{t('paymentTerminals.settings.idtechEnabled')}</Label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="idtech-environment" className="leading-6">
                {t('paymentTerminals.settings.environment')}
              </Label>
              <Select
                id="idtech-environment"
                value={form.environment}
                disabled={!canWrite}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === 'sandbox' || value === 'production') update({ environment: value });
                }}
              >
                <option value="sandbox">
                  {t('paymentTerminals.settings.environments.sandbox')}
                </option>
                <option value="production">
                  {t('paymentTerminals.settings.environments.production')}
                </option>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('paymentTerminals.settings.environmentHint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="idtech-merchant" className="leading-6">
                {t('paymentTerminals.settings.merchantId')}
              </Label>
              <Input
                id="idtech-merchant"
                value={form.merchantId}
                autoComplete="off"
                disabled={!canWrite}
                className={shown.merchantId != null ? 'border-destructive' : ''}
                onChange={(e) => {
                  update({ merchantId: e.target.value });
                }}
              />
              {shown.merchantId != null && (
                <p className="text-sm text-destructive">{shown.merchantId}</p>
              )}
            </div>
            {secretInput(
              'apiKey',
              'paymentTerminals.settings.apiKey',
              'paymentTerminals.settings.apiKeyHint',
            )}
            {secretInput(
              'apiSecret',
              'paymentTerminals.settings.apiSecret',
              'paymentTerminals.settings.apiSecretHint',
            )}
            {secretInput(
              'webhookSecret',
              'paymentTerminals.settings.webhookSecret',
              'paymentTerminals.settings.webhookSecretHint',
            )}
          </div>
          <div className="space-y-2">
            <Label className="leading-6">{t('paymentTerminals.settings.webhookUrl')}</Label>
            <IdText value={defaultWebhookUrl(data.webhookPath)} />
            <p className="text-xs text-muted-foreground">
              {t('paymentTerminals.settings.webhookUrlHint')}
            </p>
          </div>

          {canWrite && needsProof && (
            <FactorProofField
              key={`idtech-${String(proofRound)}`}
              idPrefix="idtech-proof"
              kinds={proofKinds}
              codeMethod={mfaStatus?.mfaMethod ?? null}
              description={t('paymentTerminals.settings.proofHint')}
              onChange={setProof}
              rejection={proofFailure}
              showMissing={proofAsked}
            />
          )}

          {canWrite && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {dirty && (
                <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
              )}
              {save.isSuccess && !dirty && (
                <p className="text-sm text-success">{t('common.saved')}</p>
              )}
              <SaveButton isPending={save.isPending} disabled={!dirty || save.isPending} />
              <Button
                type="button"
                variant="outline"
                className="relative"
                disabled={test.isPending || dirty || !idtech.enabled}
                onClick={() => {
                  test.mutate();
                }}
              >
                {test.isPending && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  </div>
                )}
                <span className={test.isPending ? 'invisible' : ''}>
                  {t('paymentTerminals.settings.testConnection')}
                </span>
              </Button>
            </div>
          )}
          {save.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(save.error, t, 'paymentTerminals.settings.saveFailed')}
            </p>
          )}
          {canWrite && dirty && (
            <p className="text-xs text-muted-foreground">
              {t('paymentTerminals.settings.testSaveFirst')}
            </p>
          )}
          {canWrite && !dirty && !idtech.enabled && (
            <p className="text-xs text-muted-foreground">
              {t('paymentTerminals.settings.testEnableFirst')}
            </p>
          )}
          {test.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(test.error, t, 'paymentTerminals.settings.testFailed')}
            </p>
          )}
          {test.data != null &&
            (test.data.ok ? (
              <p className="text-sm text-success">{t('paymentTerminals.settings.testSuccess')}</p>
            ) : (
              <p className="text-sm text-destructive">
                {t('paymentTerminals.settings.testRefused', { reason: test.data.reason ?? '' })}
              </p>
            ))}
        </form>
      </CardContent>
    </Card>
  );
}
