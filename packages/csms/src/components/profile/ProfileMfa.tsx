// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { LoadingLogo } from '@/components/loading-logo';
import { ProfileRecoveryCodes } from './ProfileRecoveryCodes';
import { RecoveryCodesDisplay } from './RecoveryCodesDisplay';
import { MFA_METHOD_LABELS, MfaSetupForm, type MfaSetupResponse } from '@/components/MfaSetupForm';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { MFA_STATUS_KEY, PASSKEYS_KEY, useMfaStatus } from './mfa-status';

interface MfaConfirmResponse {
  success: true;
  recoveryCodes?: string[];
}

export function ProfileMfa(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [mfaError, setMfaError] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableProof, setDisableProof] = useState<FactorProof | null>(null);
  const [disableRejection, setDisableRejection] = useState<ProofRejection | null>(null);
  const [disableSubmitted, setDisableSubmitted] = useState(false);
  const [setupProof, setSetupProof] = useState<FactorProof | null>(null);
  const [proofAsked, setProofAsked] = useState(false);
  const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);

  const { data: mfaStatus, isLoading: mfaLoading } = useMfaStatus();

  const mfaDisableMutation = useMutation({
    mutationFn: (body: { proof: FactorProof }) => api.delete('/v1/users/me/mfa', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
      // Turning MFA off removes the passkeys too.
      void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      setDisableOpen(false);
      setDisableProof(null);
      setMfaError('');
    },
    onError: (err) => {
      // Each proof works once: the field asks for what the failure used up.
      setDisableRejection(proofRejection(err));
    },
  });

  // Adding a factor with a session needs a fresh proof: a passkey the account has, else the password.
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const needsProof = proofKinds.length > 0;
  const passkeyCount = mfaStatus?.passkeyCount ?? 0;
  const passkeysOnly = mfaStatus?.mfaEnabled !== true && passkeyCount > 0;

  async function confirmWithProof(body: {
    method: string;
    code: string;
    challengeId?: string;
  }): Promise<MfaConfirmResponse> {
    try {
      return await api.post<MfaConfirmResponse>('/v1/users/me/mfa/confirm', {
        ...body,
        ...(needsProof && setupProof != null ? { proof: setupProof } : {}),
      });
    } catch (err) {
      // Each proof works once. The proof field sits on the method step, so Cancel there
      // opens it again with a fresh proof.
      setSetupProof(null);
      throw err;
    }
  }

  const setupForm =
    mfaStatus == null ? null : (
      <MfaSetupForm
        availableMethods={mfaStatus.availableMethods}
        setup={(method) => api.post<MfaSetupResponse>('/v1/users/me/mfa/setup', { method })}
        confirm={confirmWithProof}
        onConfirmed={(data) => {
          setSetupProof(null);
          setProofAsked(false);
          void queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
          if (data.recoveryCodes != null && data.recoveryCodes.length > 0) {
            setNewRecoveryCodes(data.recoveryCodes);
          }
        }}
        proofReady={!needsProof || setupProof != null}
        onProofMissing={() => {
          setProofAsked(true);
        }}
      >
        {passkeysOnly ? (
          <p className="text-sm text-muted-foreground">{t('profile.mfaAddMethodHint')}</p>
        ) : (
          <div className="flex items-center gap-2">
            <Badge variant="destructive">{t('profile.mfaDisabled')}</Badge>
          </div>
        )}
        {needsProof && (
          <FactorProofField
            idPrefix="mfa-setup-proof"
            kinds={proofKinds}
            codeMethod={mfaStatus.mfaMethod}
            description={
              proofKinds.length === 1 && proofKinds[0] === 'password'
                ? t('profile.mfaSetupPasswordHint')
                : t('factorProof.addFactorHint')
            }
            onChange={setSetupProof}
            showMissing={proofAsked}
          />
        )}
      </MfaSetupForm>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.mfaSecurity')}</CardTitle>
      </CardHeader>
      <CardContent>
        {newRecoveryCodes != null ? (
          <div className="max-w-md">
            <RecoveryCodesDisplay
              codes={newRecoveryCodes}
              onDone={() => {
                setNewRecoveryCodes(null);
              }}
            />
          </div>
        ) : mfaLoading ? (
          <LoadingLogo size="inline" />
        ) : mfaStatus == null ? null : mfaStatus.mfaEnabled ? (
          <div className="space-y-4 max-w-md">
            <div className="flex items-center gap-2">
              <Badge variant="default">{t('profile.mfaEnabled')}</Badge>
              <span className="text-sm text-muted-foreground">
                {t('profile.mfaCurrentMethod')}:{' '}
                {t(
                  (MFA_METHOD_LABELS[mfaStatus.mfaMethod ?? ''] ??
                    mfaStatus.mfaMethod ??
                    '') as never,
                )}
              </span>
            </div>
            {mfaError !== '' && <p className="text-sm text-destructive">{mfaError}</p>}
            {mfaStatus.requiredByPolicy === true ? (
              <Alert variant="info">
                <Info className="h-4 w-4" />
                <AlertDescription>{t('profile.mfaRequiredByPolicy')}</AlertDescription>
              </Alert>
            ) : (
              <>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setMfaError('');
                    setDisableProof(null);
                    setDisableRejection(null);
                    setDisableSubmitted(false);
                    mfaDisableMutation.reset();
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
                  isPending={mfaDisableMutation.isPending}
                  asForm
                  onConfirm={() => {
                    setDisableSubmitted(true);
                    if (disableProof == null) return false;
                    mfaDisableMutation.mutate({ proof: disableProof });
                    return false;
                  }}
                >
                  <FactorProofField
                    idPrefix="mfa-disable-proof"
                    kinds={mfaStatus.lastFactorProofKinds ?? []}
                    codeMethod={mfaStatus.mfaMethod}
                    onChange={setDisableProof}
                    rejection={disableRejection}
                    showMissing={disableSubmitted}
                  />
                  {mfaDisableMutation.isError && (
                    <p className="text-sm text-destructive" role="alert">
                      {getErrorMessage(mfaDisableMutation.error, t, 'profile.mfaDisableFailed')}
                    </p>
                  )}
                </ConfirmDialog>
              </>
            )}
            <ProfileRecoveryCodes
              method={mfaStatus.mfaMethod ?? ''}
              remaining={mfaStatus.recoveryCodesRemaining ?? 0}
              usedUp={mfaStatus.recoveryCodesUsedUp === true}
              passkeyCount={passkeyCount}
              onCodes={setNewRecoveryCodes}
            />
          </div>
        ) : passkeysOnly ? (
          <div className="space-y-4 max-w-md">
            <div className="flex items-center gap-2">
              <Badge variant="default">{t('profile.mfaEnabled')}</Badge>
              <span className="text-sm text-muted-foreground">
                {t('profile.mfaCurrentMethod')}: {t('profile.mfaMethodPasskey')}
              </span>
            </div>
            <ProfileRecoveryCodes
              method=""
              remaining={mfaStatus.recoveryCodesRemaining ?? 0}
              usedUp={mfaStatus.recoveryCodesUsedUp === true}
              passkeyCount={passkeyCount}
              onCodes={setNewRecoveryCodes}
            />
            {mfaStatus.availableMethods.length > 0 && (
              <div className="border-t pt-4">{setupForm}</div>
            )}
          </div>
        ) : mfaStatus.availableMethods.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('profile.mfaNotAvailable')}</p>
        ) : (
          setupForm
        )}
      </CardContent>
    </Card>
  );
}
