// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Select } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { api, getApiErrorCode } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { passwordRulesMessage } from '@/lib/password-rules';
import { usePasswordPolicy, useWeakPasswordReply } from '@/hooks/use-password-policy';
import { PasswordRequirements } from '@/components/PasswordRequirements';
import type { PasswordRule } from '@evtivity/lib/password-policy';
import { MFA_STATUS_KEY, PASSKEYS_KEY, type PortalMfaStatus } from '@/lib/mfa-status';
import { AccountRecoveryCodes } from './AccountRecoveryCodes';
import { AccountPasskeys } from './AccountPasskeys';
import { RecoveryCodesDisplay } from './RecoveryCodesDisplay';

function methodLabelKey(method: string | null): string {
  if (method === 'totp') return 'profile.mfaMethodTotp';
  if (method === 'email') return 'profile.mfaMethodEmail';
  if (method === 'sms') return 'profile.mfaMethodSms';
  return 'profile.mfaMethodPasskey';
}

export function AccountSecurity(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const passwordPolicy = usePasswordPolicy();
  const weakPasswordReply = useWeakPasswordReply();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [hasSubmittedPassword, setHasSubmittedPassword] = useState(false);
  // The rules a WEAK_PASSWORD reply named. Translated at render, cleared on edit.
  const [serverMissing, setServerMissing] = useState<PasswordRule[] | null>(null);

  const queryClient = useQueryClient();
  const { data: mfaStatus } = useQuery({
    queryKey: MFA_STATUS_KEY,
    queryFn: () => api.get<PortalMfaStatus>('/v1/portal/driver/mfa'),
  });
  const mfaEnabled = mfaStatus?.mfaEnabled === true;
  const mfaMethod = mfaStatus?.mfaMethod ?? null;
  const availableMethods = mfaStatus?.availableMethods ?? [];
  const passkeyCount = mfaStatus?.passkeyCount ?? 0;
  const passkeysOnly = !mfaEnabled && passkeyCount > 0;
  const requiredByPolicy = mfaStatus?.requiredByPolicy === true;
  // Adding a factor needs a fresh proof: the driver's current factor, else its password.
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const [chosenMfaMethod, setSelectedMfaMethod] = useState('');
  const selectedMfaMethod = chosenMfaMethod !== '' ? chosenMfaMethod : (availableMethods[0] ?? '');
  const [setupProof, setSetupProof] = useState<FactorProof | null>(null);
  const [proofAsked, setProofAsked] = useState(false);
  const [mfaSetupData, setMfaSetupData] = useState<{
    qrDataUri?: string;
    secret?: string;
    challengeId?: string;
  } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaMsg, setMfaMsg] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableProof, setDisableProof] = useState<FactorProof | null>(null);
  const [disableRejection, setDisableRejection] = useState<ProofRejection | null>(null);
  const [disableSubmitted, setDisableSubmitted] = useState(false);
  const [disablePending, setDisablePending] = useState(false);
  const [disableError, setDisableError] = useState('');
  const [hasSubmittedMfa, setHasSubmittedMfa] = useState(false);
  const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);
  const recoveryCodesRemaining = mfaStatus?.recoveryCodesRemaining ?? 0;
  const recoveryCodesUsedUp = mfaStatus?.recoveryCodesUsedUp === true;

  function refreshStatus(): void {
    void queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
  }

  function showNewRecoveryCodes(codes: string[]): void {
    setNewRecoveryCodes(codes);
    refreshStatus();
  }

  function getPasswordErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (currentPassword === '') errors.currentPassword = t('validation.required');
    if (newPassword === '') errors.newPassword = t('validation.required');
    else {
      const rulesError = passwordRulesMessage(
        newPassword,
        passwordPolicy,
        t,
        i18n.language,
        serverMissing,
      );
      if (rulesError != null) errors.newPassword = rulesError;
    }
    return errors;
  }

  const passwordErrors = getPasswordErrors();

  function getMfaErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!mfaEnabled && mfaSetupData != null) {
      if (mfaCode.trim() === '') errors.mfaCode = t('validation.required');
      else if (!/^\d{6}$/.test(mfaCode.trim())) errors.mfaCode = t('profile.mfaEnterCode');
    }
    return errors;
  }

  const mfaErrors = getMfaErrors();

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handlePasswordChange(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setHasSubmittedPassword(true);
    if (Object.keys(passwordErrors).length > 0) return;
    setPasswordMsg('');
    setPasswordLoading(true);
    try {
      await api.patch('/v1/portal/driver/password', { currentPassword, newPassword });
      setPasswordMsg(t('profile.passwordChanged'));
      setCurrentPassword('');
      setNewPassword('');
      setHasSubmittedPassword(false);
    } catch (err) {
      if (getApiErrorCode(err) === 'WEAK_PASSWORD') setServerMissing(weakPasswordReply(err) ?? []);
      else setPasswordMsg(getErrorMessage(err, t, 'profile.passwordChangeFailed'));
    } finally {
      setPasswordLoading(false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleMfaSetup(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setHasSubmittedMfa(false);
    if (proofKinds.length > 0 && setupProof == null) {
      setProofAsked(true);
      return;
    }
    setMfaMsg('');
    setMfaLoading(true);
    try {
      const data = await api.post<{ qrDataUri?: string; secret?: string; challengeId?: string }>(
        '/v1/portal/driver/mfa/setup',
        { method: selectedMfaMethod },
      );
      setMfaSetupData(data);
    } catch (err) {
      setMfaMsg(getErrorMessage(err, t, 'profile.mfaSetupFailed'));
    } finally {
      setMfaLoading(false);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleMfaConfirm(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setHasSubmittedMfa(true);
    if (Object.keys(mfaErrors).length > 0) return;
    setMfaMsg('');
    setMfaLoading(true);
    try {
      const data = await api.post<{ success: true; recoveryCodes?: string[] }>(
        '/v1/portal/driver/mfa/confirm',
        {
          method: selectedMfaMethod,
          code: mfaCode.trim(),
          challengeId: mfaSetupData?.challengeId,
          ...(proofKinds.length > 0 && setupProof != null ? { proof: setupProof } : {}),
        },
      );
      if (data.recoveryCodes != null && data.recoveryCodes.length > 0) {
        showNewRecoveryCodes(data.recoveryCodes);
      } else {
        refreshStatus();
      }
      setMfaSetupData(null);
      setMfaCode('');
      setSetupProof(null);
      setProofAsked(false);
      setHasSubmittedMfa(false);
    } catch (err) {
      setMfaMsg(getErrorMessage(err, t, 'profile.mfaVerifyFailed'));
      // Each proof works once: the driver starts the setup again with a fresh one.
      if (proofKinds.length > 0) {
        setSetupProof(null);
        setMfaSetupData(null);
        setMfaCode('');
      }
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleMfaDisable(): Promise<void> {
    if (disableProof == null) return;
    setDisableError('');
    setDisablePending(true);
    try {
      await api.delete('/v1/portal/driver/mfa', { proof: disableProof });
      refreshStatus();
      // Turning MFA off removes the passkeys too.
      void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      setDisableOpen(false);
      setDisableProof(null);
    } catch (err) {
      // Each proof works once: the field asks for what the failure used up.
      setDisableRejection(proofRejection(err));
      setDisableError(getErrorMessage(err, t, 'profile.mfaDisableFailed'));
    } finally {
      setDisablePending(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Password change */}
      <form onSubmit={(e) => void handlePasswordChange(e)} noValidate className="space-y-4">
        <h3 className="text-sm font-semibold">{t('profile.changePassword')}</h3>
        {passwordMsg !== '' && <p className="text-sm text-muted-foreground">{passwordMsg}</p>}
        <div className="space-y-2">
          <label htmlFor="secCurrentPw" className="block text-sm font-medium leading-6">
            {t('profile.currentPassword')}
          </label>
          <PasswordInput
            id="secCurrentPw"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
            }}
            className={
              hasSubmittedPassword && passwordErrors.currentPassword ? 'border-destructive' : ''
            }
          />
          {hasSubmittedPassword && passwordErrors.currentPassword && (
            <p className="text-sm text-destructive">{passwordErrors.currentPassword}</p>
          )}
        </div>
        <div className="space-y-2">
          <label htmlFor="secNewPw" className="block text-sm font-medium leading-6">
            {t('profile.newPassword')}
          </label>
          <PasswordInput
            id="secNewPw"
            value={newPassword}
            aria-invalid={hasSubmittedPassword && passwordErrors.newPassword ? true : undefined}
            aria-describedby={
              hasSubmittedPassword && passwordErrors.newPassword
                ? 'sec-new-password-error sec-password-requirements'
                : 'sec-password-requirements'
            }
            onChange={(e) => {
              setNewPassword(e.target.value);
              setServerMissing(null);
            }}
            className={
              hasSubmittedPassword && passwordErrors.newPassword ? 'border-destructive' : ''
            }
          />
          {hasSubmittedPassword && passwordErrors.newPassword && (
            <p id="sec-new-password-error" className="text-sm text-destructive">
              {passwordErrors.newPassword}
            </p>
          )}
          <PasswordRequirements
            policy={passwordPolicy}
            serverMissing={serverMissing}
            id="sec-password-requirements"
            password={newPassword}
            showUnmet={hasSubmittedPassword}
          />
        </div>
        <Button type="submit" className="w-full" disabled={passwordLoading}>
          {passwordLoading ? t('profile.changingPassword') : t('profile.changePassword')}
        </Button>
      </form>

      {/* MFA */}
      {mfaStatus != null && (mfaEnabled || passkeysOnly || availableMethods.length > 0) && (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold">{t('profile.mfaSecurity')}</h3>
          {mfaMsg !== '' && <p className="text-sm text-muted-foreground">{mfaMsg}</p>}

          {newRecoveryCodes != null ? (
            <RecoveryCodesDisplay
              codes={newRecoveryCodes}
              onDone={() => {
                setNewRecoveryCodes(null);
              }}
            />
          ) : mfaEnabled ? (
            <div className="space-y-4">
              <p className="text-sm">
                {t('profile.mfaCurrentMethod')}:{' '}
                <span className="font-medium">{t(methodLabelKey(mfaMethod))}</span> (
                {t('profile.mfaEnabled')})
              </p>
              {requiredByPolicy ? (
                <Alert variant="info">
                  <Info className="h-4 w-4" />
                  <AlertDescription>{t('profile.mfaRequiredByPolicy')}</AlertDescription>
                </Alert>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="destructive"
                    className="w-full"
                    onClick={() => {
                      setDisableProof(null);
                      setDisableRejection(null);
                      setDisableSubmitted(false);
                      setDisableError('');
                      setDisableOpen(true);
                    }}
                  >
                    {t('profile.mfaDisable')}
                  </Button>
                  <ConfirmDialog
                    open={disableOpen}
                    onOpenChange={setDisableOpen}
                    title={t('profile.mfaDisable')}
                    description={t('profile.mfaDisableConfirm')}
                    confirmLabel={t('profile.mfaDisable')}
                    variant="destructive"
                    isPending={disablePending}
                    asForm
                    onConfirm={() => {
                      setDisableSubmitted(true);
                      if (disableProof == null) return false;
                      void handleMfaDisable();
                      return false;
                    }}
                  >
                    <FactorProofField
                      idPrefix="mfa-disable-proof"
                      kinds={mfaStatus.lastFactorProofKinds ?? []}
                      codeMethod={mfaMethod}
                      onChange={setDisableProof}
                      rejection={disableRejection}
                      showMissing={disableSubmitted}
                    />
                    {disableError !== '' && (
                      <p className="text-sm text-destructive" role="alert">
                        {disableError}
                      </p>
                    )}
                  </ConfirmDialog>
                </>
              )}
              <AccountRecoveryCodes
                method={mfaMethod}
                remaining={recoveryCodesRemaining}
                usedUp={recoveryCodesUsedUp}
                passkeyCount={passkeyCount}
                onCodes={showNewRecoveryCodes}
              />
            </div>
          ) : mfaSetupData == null ? (
            <div className="space-y-4">
              <form onSubmit={(e) => void handleMfaSetup(e)} noValidate className="space-y-4">
                {passkeysOnly ? (
                  <>
                    <p className="text-sm">
                      {t('profile.mfaCurrentMethod')}:{' '}
                      <span className="font-medium">{t('profile.mfaMethodPasskey')}</span> (
                      {t('profile.mfaEnabled')})
                    </p>
                    {availableMethods.length > 0 && (
                      <p className="text-sm text-muted-foreground">
                        {t('profile.mfaAddMethodHint')}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('profile.mfaDisabled')}</p>
                )}
                {availableMethods.length > 0 && proofKinds.length > 0 && (
                  <FactorProofField
                    idPrefix="mfa-setup-proof"
                    kinds={proofKinds}
                    codeMethod={mfaMethod}
                    description={
                      proofKinds.length === 1 && proofKinds[0] === 'password'
                        ? t('profile.mfaSetupPasswordHint')
                        : t('factorProof.addFactorHint')
                    }
                    onChange={setSetupProof}
                    showMissing={proofAsked}
                  />
                )}
                {availableMethods.length > 0 && (
                  <>
                    <div className="space-y-2">
                      <label htmlFor="secMfaMethod" className="block text-sm font-medium leading-6">
                        {t('profile.mfaSelectMethod')}
                      </label>
                      <Select
                        id="secMfaMethod"
                        value={selectedMfaMethod}
                        onChange={(e) => {
                          setSelectedMfaMethod(e.target.value);
                        }}
                      >
                        {availableMethods.map((m) => (
                          <option key={m} value={m}>
                            {t(methodLabelKey(m))}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Button type="submit" className="w-full" disabled={mfaLoading}>
                      {mfaLoading ? (
                        <>
                          <Spinner className="mr-2 h-4 w-4" />
                          {t('profile.mfaSettingUp')}
                        </>
                      ) : (
                        t('profile.mfaSetUp')
                      )}
                    </Button>
                  </>
                )}
              </form>
              {passkeysOnly && (
                <AccountRecoveryCodes
                  method={null}
                  remaining={recoveryCodesRemaining}
                  usedUp={recoveryCodesUsedUp}
                  passkeyCount={passkeyCount}
                  onCodes={showNewRecoveryCodes}
                />
              )}
            </div>
          ) : (
            <form onSubmit={(e) => void handleMfaConfirm(e)} noValidate className="space-y-4">
              {selectedMfaMethod === 'totp' && mfaSetupData.qrDataUri != null && (
                <div className="space-y-3">
                  <p className="text-sm font-medium">{t('profile.mfaScanQr')}</p>
                  <img
                    src={mfaSetupData.qrDataUri}
                    alt={t('profile.mfaQrCode')}
                    className="mx-auto"
                  />
                  {mfaSetupData.secret != null && (
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">{t('profile.mfaManualEntry')}</p>
                      <code className="block rounded bg-muted px-3 py-2 text-center text-sm">
                        {mfaSetupData.secret}
                      </code>
                    </div>
                  )}
                </div>
              )}
              <div className="space-y-2">
                <label htmlFor="secMfaCode" className="block text-sm font-medium leading-6">
                  {t('profile.mfaEnterCode')}
                </label>
                <Input
                  id="secMfaCode"
                  value={mfaCode}
                  onChange={(e) => {
                    setMfaCode(e.target.value);
                  }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-invalid={hasSubmittedMfa && mfaErrors.mfaCode ? true : undefined}
                  aria-describedby={
                    hasSubmittedMfa && mfaErrors.mfaCode ? 'sec-mfa-code-error' : undefined
                  }
                  className={hasSubmittedMfa && mfaErrors.mfaCode ? 'border-destructive' : ''}
                />
                {hasSubmittedMfa && mfaErrors.mfaCode && (
                  <p id="sec-mfa-code-error" className="text-sm text-destructive">
                    {mfaErrors.mfaCode}
                  </p>
                )}
              </div>
              <Button type="submit" className="w-full" disabled={mfaLoading}>
                {mfaLoading ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" />
                    {t('profile.mfaVerifying')}
                  </>
                ) : (
                  t('profile.mfaVerify')
                )}
              </Button>
            </form>
          )}
        </div>
      )}
      {mfaStatus != null && <AccountPasskeys status={mfaStatus} />}
    </div>
  );
}
