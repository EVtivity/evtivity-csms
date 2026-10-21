// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { LiveStatus } from '@/components/LiveStatus';
import { SECURITY_PUBLIC_QUERY_KEY } from '@/hooks/use-password-policy';
import { usePrefetchedOptions } from '@/hooks/use-prefetched-options';
import {
  startAuthentication,
  WebAuthnAbortService,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { useAuth, MustResetPasswordError, type User } from '@/lib/auth';
import {
  ceremonyFailure,
  passkeyErrorText,
  type PasskeyErrorText,
  webauthnAutofillSupported,
  webauthnSupported,
} from '@/lib/webauthn';
import { api, ApiError } from '@/lib/api';
import { isRateLimited } from '@/lib/error-message';
import { executeRecaptcha } from '@/lib/recaptcha';
import { MfaChallenge } from '@/components/MfaChallenge';
import { readSsoMfaFragment } from '@/lib/sso-mfa';
import { hasSsoMfaFragment, ssoFragmentFromThisTab, ssoLoginUrl } from '@/lib/sso-signin';
import { readSsoEnrollmentFragment } from '@/lib/mfa-enrollment';
import { rememberReturnTo, takeReturnTo } from '@/lib/return-to';

const DEV_AUTO_LOGIN = import.meta.env.VITE_CSMS_AUTO_LOGIN;

// The error is kept as a translation key and translated at render, so it follows the active
// language instead of the one loaded when it was set.
type LoginErrorKey =
  | 'auth.invalidCredentials'
  | 'auth.recaptchaFailed'
  | 'auth.ssoNoEmail'
  | 'auth.ssoAccountDisabled'
  | 'auth.ssoUserNotFound'
  | 'auth.ssoConfigError'
  | 'auth.ssoDomainNotAllowed'
  | 'auth.ssoSessionMismatch'
  | 'errors.MFA_SETUP_UNAVAILABLE'
  | 'errors.MFA_POLICY_UNAVAILABLE'
  | 'errors.RATE_LIMITED';

interface SecurityPublic {
  recaptchaEnabled: boolean;
  recaptchaSiteKey: string;
  mfaMethods: string[];
  ssoEnabled: boolean;
  /** Passwordless sign-in with a passkey (Settings > Security > MFA). */
  passkeyLoginEnabled?: boolean;
}

interface PasskeyLoginReply {
  mustResetPassword?: true;
  user?: User;
  role?: { id: string; name: string } | null;
}

/** Whether a passkey attempt may still start its browser prompt (the page is open, no MFA step). */
interface PasskeyGuard {
  readonly active: boolean;
}

/** How a passkey attempt ended: signed in (or sent to change the password), or not. */
type PasskeyOutcome = 'done' | 'aborted' | 'cancelled' | 'failed';

/**
 * Autofill starts again on its own after a dismissed prompt or a failure that is not
 * the user's (a 429, a 503, an expired challenge), but at most this many times in a
 * row: Chromium refuses the autofill request at once when it has no passkey to list,
 * and a server that keeps failing is not asked again and again. The passkey button
 * and a focus on the email field start it again.
 */
const MAX_AUTOFILL_RETRIES = 3;

function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body as { code?: unknown } | null;
  return body != null && typeof body === 'object' && typeof body.code === 'string'
    ? body.code
    : null;
}

function passkeyLoginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return api.post<PublicKeyCredentialRequestOptionsJSON>('/v1/auth/passkey/options', {});
}

export function Login(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useAuth((s) => s.login);
  const mfaPending = useAuth((s) => s.mfaPending);
  const setMfaPending = useAuth((s) => s.setMfaPending);
  const mfaEnrollment = useAuth((s) => s.mfaEnrollment);
  const setMfaEnrollment = useAuth((s) => s.setMfaEnrollment);
  const completeMfaLogin = useAuth((s) => s.completeMfaLogin);
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  const [passkeyMessage, setPasskeyMessage] = useState<PasskeyErrorText | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<LoginErrorKey | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  // Bumped to start the autofill prompt again after one ended.
  const [autofillRound, setAutofillRound] = useState(0);
  const autoLoginAttempted = useRef(false);
  // The attempt that showed the pending button; only it may end the pending state.
  const pendingOwner = useRef<object | null>(null);
  const autofillRetries = useRef(0);
  // Autofill stopped after its restarts and waits for the button or the email field.
  const autofillIdle = useRef(false);
  const page = useRef({ active: true });

  const [searchParams] = useSearchParams();
  const { companyName, companyLogo, portalUrl, themeColor } = useAuthBranding();

  // An SSO login of a user with MFA lands here with the MFA pending state in
  // the URL fragment: show the MFA challenge and drop the token from the URL.
  useEffect(() => {
    // Only the SSO sign-in this tab started: a link carrying someone else's MFA state is ignored.
    if (hasSsoMfaFragment(window.location.hash) && !ssoFragmentFromThisTab(window.location.hash)) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return;
    }
    const enrollment = readSsoEnrollmentFragment(window.location.hash);
    if (enrollment != null) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setMfaEnrollment(enrollment);
      return;
    }
    const pending = readSsoMfaFragment(window.location.hash);
    if (pending == null) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setMfaPending(pending);
  }, [setMfaPending, setMfaEnrollment]);

  // Required MFA (password, SSO or the MFA step): set up a method before the session.
  useEffect(() => {
    if (mfaEnrollment != null) void navigate('/mfa-setup');
  }, [mfaEnrollment, navigate]);

  // Handle SSO error query params
  useEffect(() => {
    const ssoError = searchParams.get('error');
    if (ssoError == null) return;
    const errorMap: Record<string, LoginErrorKey> = {
      sso_no_email: 'auth.ssoNoEmail',
      sso_account_disabled: 'auth.ssoAccountDisabled',
      sso_user_not_found: 'auth.ssoUserNotFound',
      sso_config_error: 'auth.ssoConfigError',
      sso_domain_not_allowed: 'auth.ssoDomainNotAllowed',
      sso_mfa_setup_unavailable: 'errors.MFA_SETUP_UNAVAILABLE',
      sso_mfa_policy_unavailable: 'errors.MFA_POLICY_UNAVAILABLE',
      sso_session_mismatch: 'auth.ssoSessionMismatch',
    };
    const key = errorMap[ssoError];
    if (key != null) setError(key);
  }, [searchParams]);

  const { data: securityPublic } = useQuery({
    queryKey: SECURITY_PUBLIC_QUERY_KEY,
    queryFn: () => api.get<SecurityPublic>('/v1/security/public'),
  });

  // A protected deep link sent the user here with ?returnTo=; keep it across
  // MFA and the SSO round trip (lib/return-to.ts).
  useEffect(() => {
    rememberReturnTo(searchParams);
  }, [searchParams]);

  useEffect(() => {
    if (isAuthenticated) {
      void navigate(takeReturnTo() ?? '/', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const passkeyLogin = securityPublic?.passkeyLoginEnabled === true && webauthnSupported();
  // The button's options are fetched before the click, so the prompt starts inside it.
  const buttonPrompt = usePrefetchedOptions(
    passkeyLoginOptions,
    passkeyLogin && mfaPending == null && !passkeyPending,
  );

  useEffect(() => {
    page.current.active = true;
    return () => {
      page.current.active = false;
    };
  }, []);

  // A passkey alone signs in: the API answers the session, as the MFA step does.
  async function passkeySignIn(
    useBrowserAutofill: boolean,
    guard: PasskeyGuard,
  ): Promise<PasskeyOutcome> {
    const attempt = {};
    const showPending = (): void => {
      pendingOwner.current = attempt;
      setPasskeyPending(true);
    };
    let picked = false;
    try {
      if (!useBrowserAutofill) showPending();
      const ready = useBrowserAutofill ? null : buttonPrompt.take();
      let optionsJSON: PublicKeyCredentialRequestOptionsJSON;
      if (ready != null) {
        optionsJSON = ready;
      } else {
        optionsJSON = await (useBrowserAutofill ? passkeyLoginOptions() : buttonPrompt.load());
        // Leaving the page or opening the MFA step during the fetch starts no prompt, and
        // autofill never replaces the prompt of the button.
        if (!guard.active) return 'aborted';
        if (useBrowserAutofill && pendingOwner.current != null) return 'aborted';
      }
      const credential = await startAuthentication({ optionsJSON, useBrowserAutofill });
      picked = true;
      if (useBrowserAutofill) showPending();
      setError(null);
      setPasskeyMessage(null);
      const data = await api.post<PasskeyLoginReply>('/v1/auth/passkey/verify', { credential });
      if (data.mustResetPassword === true) {
        setPasskeyMessage({ message: t('auth.passkeyResetRequired'), quiet: false });
        return 'done';
      }
      if (data.user != null) await completeMfaLogin(data.user, data.role?.name ?? null);
      return 'done';
    } catch (err) {
      // The page cancels a waiting autofill prompt when another one starts or the page closes.
      const failure = ceremonyFailure(err);
      if (failure === 'aborted') return 'aborted';
      if (useBrowserAutofill) {
        // A dismissed autofill prompt needs no message: the form is still there.
        if (failure === 'cancelled') return 'cancelled';
        // Nothing the user asked for failed (the options, or a challenge that expired
        // while the list waited): no message, autofill starts again.
        if (!picked || apiErrorCode(err) === 'WEBAUTHN_CHALLENGE_EXPIRED') {
          console.warn('Passkey autofill failed, offering it again', err);
          return 'failed';
        }
      }
      setPasskeyMessage(passkeyErrorText(err, t, 'auth.passkeyFailed'));
      return 'failed';
    } finally {
      if (pendingOwner.current === attempt) {
        pendingOwner.current = null;
        setPasskeyPending(false);
      }
    }
  }

  // Passkeys in the email field's autofill list while the sign-in form shows; cancelled on leaving.
  useEffect(() => {
    if (!passkeyLogin || mfaPending != null) return;
    const run = { active: true };
    autofillIdle.current = false;
    void (async () => {
      let supported: boolean;
      try {
        supported = await webauthnAutofillSupported();
      } catch (err) {
        console.warn('Passkey autofill check failed, offering the button only', err);
        return;
      }
      if (!supported || !run.active) return;
      // A prompt cut short by leaving the page or the MFA step ends as aborted: no restart.
      const outcome = await passkeySignIn(true, run);
      if (
        (outcome === 'cancelled' || outcome === 'failed') &&
        autofillRetries.current < MAX_AUTOFILL_RETRIES
      ) {
        autofillRetries.current += 1;
        setAutofillRound((r) => r + 1);
      } else if (outcome !== 'aborted') {
        autofillIdle.current = true;
      }
    })();
    return () => {
      run.active = false;
      WebAuthnAbortService.cancelCeremony();
    };
  }, [passkeyLogin, mfaPending, autofillRound]);

  // The button's prompt replaced the autofill one: offer autofill again once it ends.
  async function signInWithPasskeyButton(): Promise<void> {
    const outcome = await passkeySignIn(false, page.current);
    if (outcome === 'done' || !page.current.active) return;
    autofillRetries.current = 0;
    setAutofillRound((r) => r + 1);
  }

  const noAutoLogin =
    searchParams.get('noAutoLogin') === 'true' || sessionStorage.getItem('noAutoLogin') === 'true';

  useEffect(() => {
    if (
      DEV_AUTO_LOGIN &&
      !noAutoLogin &&
      !isAuthenticated &&
      !autoLoginAttempted.current &&
      securityPublic !== undefined
    ) {
      autoLoginAttempted.current = true;
      void (async () => {
        let recaptchaToken: string | undefined;
        if (securityPublic.recaptchaEnabled && securityPublic.recaptchaSiteKey !== '') {
          recaptchaToken = await executeRecaptcha(securityPublic.recaptchaSiteKey, 'login');
        }
        await login(DEV_AUTO_LOGIN, 'admin123', recaptchaToken);
      })();
    }
  }, [isAuthenticated, login, securityPublic]);

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (email.trim() === '') errors.email = t('validation.required');
    if (password === '') errors.password = t('validation.required');
    return errors;
  }

  const validationErrors = getValidationErrors();
  const hasErrors = Object.keys(validationErrors).length > 0;

  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    setHasSubmitted(true);
    if (hasErrors) return;
    setError(null);
    setPasskeyMessage(null);
    setLoading(true);
    try {
      let recaptchaToken: string | undefined;
      if (securityPublic?.recaptchaEnabled && securityPublic.recaptchaSiteKey !== '') {
        recaptchaToken = await executeRecaptcha(securityPublic.recaptchaSiteKey, 'login');
      }
      await login(email, password, recaptchaToken);
    } catch (err) {
      if (err instanceof MustResetPasswordError) {
        void navigate('/set-password', { state: { email } });
        return;
      }
      if (isRateLimited(err)) {
        setError('errors.RATE_LIMITED');
      } else if (err instanceof ApiError) {
        const body = err.body as { code?: string } | null;
        if (body?.code === 'RECAPTCHA_REQUIRED' || body?.code === 'RECAPTCHA_FAILED') {
          setError('auth.recaptchaFailed');
        } else if (body?.code === 'MFA_SETUP_UNAVAILABLE') {
          setError('errors.MFA_SETUP_UNAVAILABLE');
        } else if (body?.code === 'MFA_POLICY_UNAVAILABLE') {
          setError('errors.MFA_POLICY_UNAVAILABLE');
        } else {
          setError('auth.invalidCredentials');
        }
      } else {
        setError('auth.invalidCredentials');
      }
    } finally {
      setLoading(false);
    }
  }

  if (mfaPending != null) {
    return <MfaChallenge />;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      {portalUrl != null && (
        <a
          href={portalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="fixed top-8 right-0 inline-flex items-center gap-2 rounded-l-full px-5 py-3 text-sm font-medium text-primary-foreground shadow-md transition-opacity hover:opacity-90"
          style={{ backgroundColor: themeColor }}
        >
          {companyName ?? 'EVtivity'} Charging Portal
        </a>
      )}
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <h2 className="text-2xl font-semibold">{t('auth.signIn')}</h2>
          {error != null && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {t(error)}
            </p>
          )}
          {passkeyMessage != null && !passkeyMessage.quiet && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {passkeyMessage.message}
            </p>
          )}
          <LiveStatus
            message={passkeyMessage?.quiet === true ? passkeyMessage.message : null}
            className="mt-2"
          />
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
            noValidate
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="email" className="leading-6">
                {t('auth.emailLabel')}
              </Label>
              <Input
                id="email"
                type="email"
                // "webauthn" lets the browser list passkeys under the field.
                autoComplete={passkeyLogin ? 'username webauthn' : 'off'}
                value={email}
                onFocus={() => {
                  if (!autofillIdle.current) return;
                  autofillIdle.current = false;
                  autofillRetries.current = 0;
                  setAutofillRound((r) => r + 1);
                }}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                className={hasSubmitted && validationErrors.email ? 'border-destructive' : ''}
              />
              {hasSubmitted && validationErrors.email && (
                <p className="text-sm text-destructive">{validationErrors.email}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="leading-6">
                {t('auth.passwordLabel')}
              </Label>
              <PasswordInput
                id="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
                className={hasSubmitted && validationErrors.password ? 'border-destructive' : ''}
              />
              {hasSubmitted && validationErrors.password && (
                <p className="text-sm text-destructive">{validationErrors.password}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t('auth.signingIn') : t('auth.signIn')}
            </Button>
            <div className="text-center">
              <Link to="/forgot-password" className="text-sm font-medium text-link hover:underline">
                {t('auth.forgotPassword')}
              </Link>
            </div>
            {(passkeyLogin || securityPublic?.ssoEnabled === true) && (
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">{t('auth.or')}</span>
                </div>
              </div>
            )}
            {passkeyLogin && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={passkeyPending}
                onClick={() => {
                  setError(null);
                  setPasskeyMessage(null);
                  void signInWithPasskeyButton();
                }}
              >
                {passkeyPending ? t('auth.signingIn') : t('auth.signInWithPasskey')}
              </Button>
            )}
            {securityPublic?.ssoEnabled && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  window.location.href = ssoLoginUrl();
                }}
              >
                {t('auth.signInWithSso')}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
      <AuthFooter companyName={companyName} recaptchaEnabled={securityPublic?.recaptchaEnabled} />
    </div>
  );
}
