// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { MfaSetupForm, type MfaSetupResponse } from '@/components/MfaSetupForm';
import { RecoveryCodesDisplay } from '@/components/account/RecoveryCodesDisplay';
import { LiveStatus } from '@/components/LiveStatus';
import { usePrefetchedOptions } from '@/hooks/use-prefetched-options';
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { useAuth, type Driver } from '@/lib/auth';
import { enrollmentPost } from '@/lib/mfa-enrollment';
import {
  passkeyDefaultNameKey,
  passkeyErrorText,
  webauthnSupported,
  type PasskeyErrorText,
} from '@/lib/webauthn';

interface EnrollmentConfirmResponse {
  success: true;
  recoveryCodes?: string[];
  driver?: Driver;
}

/**
 * The MFA setup a portal sign-in requires before it issues a session (required
 * MFA for drivers). The enrollment token stays in the auth store (memory).
 * Confirming signs the driver in; the new recovery codes show once, then the
 * portal opens.
 */
export function MfaSetup(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const enrollment = useAuth((s) => s.mfaEnrollment);
  const clearMfaEnrollment = useAuth((s) => s.clearMfaEnrollment);
  const completeMfaLogin = useAuth((s) => s.completeMfaLogin);
  const { companyName, companyLogo, branding } = useAuthBranding();
  const [expired, setExpired] = useState(false);
  const [confirmed, setConfirmed] = useState<EnrollmentConfirmResponse | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyMessage, setPasskeyMessage] = useState<PasskeyErrorText | null>(null);
  const passkeyAvailable = enrollment?.webauthnAvailable === true && webauthnSupported();
  const passkeyPrompt = usePrefetchedOptions(
    () =>
      enrollmentPost<PublicKeyCredentialCreationOptionsJSON>(
        '/v1/portal/driver/webauthn/registration-options',
        enrollment?.enrollmentToken ?? '',
        {},
      ),
    passkeyAvailable && !expired && !passkeyPending,
  );

  if (enrollment == null && confirmed == null) return <Navigate to="/login" replace />;

  // A refused token (expired, used, or MFA set up elsewhere) needs a new sign-in.
  async function withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    try {
      return await call(enrollment?.enrollmentToken ?? '');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setExpired(true);
      throw err;
    }
  }

  // The passkey is the enrolled factor: registering it signs the user in.
  async function enrollPasskey(): Promise<void> {
    setPasskeyPending(true);
    setPasskeyMessage(null);
    try {
      // Prefetched options start the prompt inside the click (Safari needs that).
      const optionsJSON = passkeyPrompt.take() ?? (await withToken(() => passkeyPrompt.load()));
      const credential = await startRegistration({ optionsJSON });
      const data = await withToken((token) =>
        enrollmentPost<EnrollmentConfirmResponse>(
          '/v1/portal/driver/webauthn/registration',
          token,
          {
            credential,
            name: t(passkeyDefaultNameKey(credential)),
          },
        ),
      );
      setConfirmed(data);
    } catch (err) {
      setPasskeyMessage(passkeyErrorText(err, t));
    } finally {
      setPasskeyPending(false);
    }
  }

  async function finish(data: EnrollmentConfirmResponse): Promise<void> {
    if (data.driver != null) await completeMfaLogin(data.driver);
    clearMfaEnrollment();
    void navigate('/', { replace: true });
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <h2 className="text-2xl font-semibold">{t('auth.mfaSetupTitle')}</h2>
          {confirmed == null && (
            <p className="mt-2 text-sm text-muted-foreground">{t('auth.mfaSetupDescription')}</p>
          )}
        </CardHeader>
        <CardContent>
          {confirmed != null ? (
            <RecoveryCodesDisplay
              codes={confirmed.recoveryCodes ?? []}
              accountEmail={confirmed.driver?.email ?? null}
              onDone={() => {
                void finish(confirmed);
              }}
            />
          ) : expired ? (
            <div className="space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{t('auth.mfaSetupExpired')}</AlertDescription>
              </Alert>
              <div className="text-center">
                <Link
                  to="/login"
                  onClick={() => {
                    clearMfaEnrollment();
                  }}
                  className="text-sm text-link hover:underline"
                >
                  {t('auth.backToLogin')}
                </Link>
              </div>
            </div>
          ) : enrollment == null ||
            (enrollment.availableMethods.length === 0 && !passkeyAvailable) ? (
            <p className="text-center text-sm text-muted-foreground">
              {t('profile.mfaNotAvailable')}
            </p>
          ) : (
            <div className="space-y-4">
              {passkeyAvailable && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{t('auth.mfaSetupPasskeyHint')}</p>
                  <Button
                    type="button"
                    className="w-full"
                    disabled={passkeyPending}
                    onClick={() => {
                      void enrollPasskey();
                    }}
                  >
                    {passkeyPending ? t('passkeys.waiting') : t('auth.mfaSetupUsePasskey')}
                  </Button>
                  <LiveStatus
                    message={passkeyMessage?.quiet === true ? passkeyMessage.message : null}
                  />
                  {passkeyMessage != null && !passkeyMessage.quiet && (
                    <p className="text-sm text-destructive" role="alert">
                      {passkeyMessage.message}
                    </p>
                  )}
                </div>
              )}
              {passkeyAvailable && enrollment.availableMethods.length > 0 && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">{t('auth.or')}</span>
                  </div>
                </div>
              )}
              {enrollment.availableMethods.length > 0 && (
                <MfaSetupForm
                  availableMethods={enrollment.availableMethods}
                  setup={(method) =>
                    withToken((token) =>
                      enrollmentPost<MfaSetupResponse>('/v1/portal/driver/mfa/setup', token, {
                        method,
                      }),
                    )
                  }
                  confirm={(body) =>
                    withToken((token) =>
                      enrollmentPost<EnrollmentConfirmResponse>(
                        '/v1/portal/driver/mfa/confirm',
                        token,
                        body,
                      ),
                    )
                  }
                  onConfirmed={(data) => {
                    setConfirmed(data);
                  }}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
