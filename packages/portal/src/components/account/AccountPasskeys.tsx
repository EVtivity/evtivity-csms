// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LoadingLogo } from '@/components/loading-logo';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { LiveStatus } from '@/components/LiveStatus';
import { usePrefetchedOptions } from '@/hooks/use-prefetched-options';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';
import { MFA_STATUS_KEY, PASSKEYS_KEY, type PortalMfaStatus } from '@/lib/mfa-status';
import { passkeyDefaultNameKey, passkeyErrorText, webauthnSupported } from '@/lib/webauthn';
import { RecoveryCodesDisplay } from './RecoveryCodesDisplay';

/** GET /v1/portal/driver/webauthn. */
export interface PasskeyCredential {
  id: number;
  name: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  aaguid: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface RegistrationReply {
  credential: PasskeyCredential;
  recoveryCodes?: string[];
}

/** The stored name allows 1 to 100 characters. */
const NAME_MAX = 100;

type PasskeyTypeKey =
  | 'passkeys.typeSynced'
  | 'passkeys.typeNotBackedUp'
  | 'passkeys.typeDeviceBound';

/** A synced passkey, one that can sync but is not backed up yet, or one bound to a device or key. */
export function passkeyTypeKey(
  c: Pick<PasskeyCredential, 'deviceType' | 'backedUp'>,
): PasskeyTypeKey {
  if (c.deviceType === 'multiDevice') {
    return c.backedUp ? 'passkeys.typeSynced' : 'passkeys.typeNotBackedUp';
  }
  return 'passkeys.typeDeviceBound';
}

function registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return api.post<PublicKeyCredentialCreationOptionsJSON>(
    '/v1/portal/driver/webauthn/registration-options',
    {},
  );
}

function nameError(
  name: string,
  t: (key: 'validation.required' | 'passkeys.nameTooLong') => string,
): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return t('validation.required');
  return trimmed.length > NAME_MAX ? t('passkeys.nameTooLong') : null;
}

const LABEL_CLASS = 'block text-sm font-medium leading-6';

/**
 * Proof, then the browser prompt, then the registration. The credential gets
 * its default name ("Passkey" or "Security Key") in the driver's language; the
 * next step lets the driver pick another.
 */
function AddPasskeyPanel({
  proofKinds,
  codeMethod,
  onRegistered,
  onCancel,
}: {
  proofKinds: string[];
  codeMethod: string | null;
  onRegistered: (reply: RegistrationReply) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [rejection, setRejection] = useState<ProofRejection | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const needsProof = proofKinds.length > 0;
  const prompt = usePrefetchedOptions(registrationOptions, !pending);

  async function register(): Promise<void> {
    setPending(true);
    setError('');
    setNotice('');
    let sentProof = false;
    try {
      // Prefetched options start the prompt inside the click (Safari needs that).
      const optionsJSON = prompt.take() ?? (await prompt.load());
      const credential = await startRegistration({ optionsJSON });
      sentProof = needsProof;
      const reply = await api.post<RegistrationReply>('/v1/portal/driver/webauthn/registration', {
        credential,
        name: t(passkeyDefaultNameKey(credential)),
        ...(needsProof && proof != null ? { proof } : {}),
      });
      onRegistered(reply);
    } catch (err) {
      const text = passkeyErrorText(err, t);
      if (text.quiet) setNotice(text.message);
      else setError(text.message);
      // Once sent, the proof may be used up whatever failed after it: ask for what it spent.
      if (sentProof) {
        setRejection(proofRejection(err));
        setHasSubmitted(false);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      className="space-y-4 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setHasSubmitted(true);
        if (needsProof && proof == null) return;
        void register();
      }}
    >
      <p className="text-sm text-muted-foreground">{t('passkeys.addHint')}</p>
      {needsProof && (
        <FactorProofField
          idPrefix="passkey-proof"
          kinds={proofKinds}
          codeMethod={codeMethod}
          description={t('factorProof.addFactorHint')}
          onChange={setProof}
          rejection={rejection}
          showMissing={hasSubmitted}
        />
      )}
      <LiveStatus message={notice} />
      {error !== '' && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? t('passkeys.waiting') : t('passkeys.continue')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Names the credential just registered; Keep This Name keeps the default name. */
function NamePasskeyForm({
  credential,
  onDone,
}: {
  credential: PasskeyCredential;
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(credential.name);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: (value: string) =>
      api.patch<PasskeyCredential>(`/v1/portal/driver/webauthn/${String(credential.id)}`, {
        name: value,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      onDone();
    },
  });

  const invalid = nameError(name, t);

  return (
    <form
      noValidate
      className="space-y-4 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setHasSubmitted(true);
        if (invalid != null) return;
        // The default name is already stored: only a name the driver picked needs saving.
        if (name.trim() === credential.name) {
          onDone();
          return;
        }
        mutation.mutate(name.trim());
      }}
    >
      <p className="text-sm text-success" role="status">
        {t('passkeys.added')}
      </p>
      <div className="space-y-2">
        <label htmlFor="passkey-new-name" className={LABEL_CLASS}>
          {t('passkeys.nameLabel')}
        </label>
        <Input
          id="passkey-new-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            mutation.reset();
          }}
          className={hasSubmitted && invalid != null ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">{t('passkeys.nameHint')}</p>
        {hasSubmitted && invalid != null && (
          <p className="text-sm text-destructive" role="alert">
            {invalid}
          </p>
        )}
      </div>
      {mutation.isError && (
        <p className="text-sm text-destructive" role="alert">
          {getErrorMessage(mutation.error, t, 'passkeys.renameFailed')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? t('common.saving') : t('common.save')}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('passkeys.keepName')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Account > Security: the passkeys and security keys of the driver. Add asks
 * for the fresh proof the account needs, then the browser prompt, then a name;
 * a first factor shows the recovery codes once.
 */
export function AccountPasskeys({ status }: { status: PortalMfaStatus }): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const timezone = useDriverTimezone();
  const supported = webauthnSupported();
  const {
    data: credentials,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: PASSKEYS_KEY,
    queryFn: () => api.get<PasskeyCredential[]>('/v1/portal/driver/webauthn'),
  });

  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState<RegistrationReply | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<PasskeyCredential | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSubmitted, setRenameSubmitted] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PasskeyCredential | null>(null);
  const [removeProof, setRemoveProof] = useState<FactorProof | null>(null);
  const [removeRejection, setRemoveRejection] = useState<ProofRejection | null>(null);
  const [removeSubmitted, setRemoveSubmitted] = useState(false);

  const list = credentials ?? [];
  const enabled = status.webauthnEnabled !== false;
  // The server's rule: no email, SMS or TOTP method and one passkey.
  const lastFactor = status.lastFactorIsPasskey === true;
  const lastFactorProofKinds = status.lastFactorProofKinds ?? [];
  const lockedByPolicy = lastFactor && status.requiredByPolicy === true;

  function refreshAll(): void {
    void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
    void queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
  }

  const renameMutation = useMutation({
    mutationFn: (vars: { id: number; name: string }) =>
      api.patch<PasskeyCredential>(`/v1/portal/driver/webauthn/${String(vars.id)}`, {
        name: vars.name,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      setRenameTarget(null);
    },
  });

  // The API ends the driver's sessions and gives this browser a new one.
  const removeMutation = useMutation({
    mutationFn: (vars: { id: number; proof?: FactorProof }) =>
      api.delete(
        `/v1/portal/driver/webauthn/${String(vars.id)}`,
        vars.proof != null ? { proof: vars.proof } : {},
      ),
    onSuccess: () => {
      refreshAll();
      setRemoveTarget(null);
      setRemoveProof(null);
    },
    onError: (err: unknown, vars) => {
      if (vars.proof != null) setRemoveRejection(proofRejection(err));
    },
  });

  const renameInvalid = nameError(renameValue, t);

  return (
    <div className="space-y-4 border-t pt-4" data-testid="account-passkeys">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t('passkeys.title')}</h3>
        <p className="text-sm text-muted-foreground">
          {t(
            status.passkeyLoginEnabled === true
              ? 'passkeys.descriptionWithSignIn'
              : 'passkeys.description',
          )}
        </p>
      </div>
      {!supported && (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertDescription>{t('passkeys.needsSecurePage')}</AlertDescription>
        </Alert>
      )}
      {supported && !enabled && (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertDescription>{t('passkeys.turnedOff')}</AlertDescription>
        </Alert>
      )}
      {isLoading ? (
        <LoadingLogo size="inline" />
      ) : isError ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive">{t('passkeys.loadError')}</p>
          <Button
            variant="outline"
            onClick={() => {
              void refetch();
            }}
          >
            {t('passkeys.retry')}
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground">{t('passkeys.empty')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {list.map((c) => (
            <li key={c.id} className="space-y-2 p-3" data-testid={`passkey-row-${String(c.id)}`}>
              <div className="space-y-0.5">
                <p className="font-medium wrap-anywhere">{c.name}</p>
                <p className="text-xs text-muted-foreground">{t(passkeyTypeKey(c))}</p>
                <p className="text-xs text-muted-foreground">
                  {t('passkeys.createdOn', { date: formatDate(c.createdAt, timezone) })}
                  {' · '}
                  {c.lastUsedAt != null
                    ? t('passkeys.lastUsedOn', { date: formatDate(c.lastUsedAt, timezone) })
                    : t('passkeys.neverUsed')}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    renameMutation.reset();
                    setRenameValue(c.name);
                    setRenameSubmitted(false);
                    setRenameTarget(c);
                  }}
                >
                  {t('passkeys.rename')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={lockedByPolicy}
                  onClick={() => {
                    removeMutation.reset();
                    setRemoveProof(null);
                    setRemoveRejection(null);
                    setRemoveSubmitted(false);
                    setRemoveTarget(c);
                  }}
                >
                  {t('passkeys.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {lockedByPolicy && (
        <p className="text-sm text-muted-foreground">{t('passkeys.lastFactorRequired')}</p>
      )}
      {newCodes != null ? (
        <RecoveryCodesDisplay
          codes={newCodes}
          onDone={() => {
            setNewCodes(null);
          }}
        />
      ) : justAdded != null ? (
        <NamePasskeyForm
          credential={justAdded.credential}
          onDone={() => {
            const codes = justAdded.recoveryCodes;
            setJustAdded(null);
            if (codes != null && codes.length > 0) setNewCodes(codes);
          }}
        />
      ) : adding ? (
        <AddPasskeyPanel
          proofKinds={status.factorProofKinds ?? []}
          codeMethod={status.mfaMethod}
          onCancel={() => {
            setAdding(false);
          }}
          onRegistered={(reply) => {
            setAdding(false);
            setJustAdded(reply);
            refreshAll();
          }}
        />
      ) : (
        supported &&
        enabled && (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('passkeys.add')}
          </Button>
        )
      )}
      <ConfirmDialog
        open={renameTarget != null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        title={t('passkeys.renameTitle')}
        description={t('passkeys.renameDescription')}
        confirmLabel={t('common.save')}
        isPending={renameMutation.isPending}
        asForm
        onConfirm={() => {
          setRenameSubmitted(true);
          if (renameTarget != null && renameInvalid == null) {
            renameMutation.mutate({ id: renameTarget.id, name: renameValue.trim() });
          }
          return false;
        }}
      >
        <div className="space-y-2">
          <label htmlFor="passkey-rename" className={LABEL_CLASS}>
            {t('passkeys.nameLabel')}
          </label>
          <Input
            id="passkey-rename"
            value={renameValue}
            onChange={(e) => {
              setRenameValue(e.target.value);
              renameMutation.reset();
            }}
            className={renameSubmitted && renameInvalid != null ? 'border-destructive' : ''}
          />
          {renameSubmitted && renameInvalid != null && (
            <p className="text-sm text-destructive" role="alert">
              {renameInvalid}
            </p>
          )}
          {renameMutation.isError && (
            <p className="text-sm text-destructive" role="alert">
              {getErrorMessage(renameMutation.error, t, 'passkeys.renameFailed')}
            </p>
          )}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={t('passkeys.removeTitle')}
        description={t('passkeys.removeDescription', { name: removeTarget?.name ?? '' })}
        confirmLabel={t('passkeys.remove')}
        variant="destructive"
        isPending={removeMutation.isPending}
        asForm
        onConfirm={() => {
          setRemoveSubmitted(true);
          if (removeTarget == null) return false;
          // Every removal needs a fresh proof, not only the last factor's.
          if (removeProof == null) return false;
          removeMutation.mutate({
            id: removeTarget.id,
            proof: removeProof,
          });
          return false;
        }}
      >
        <div className="space-y-3">
          {lastFactor && (
            <Alert variant="warning">
              <Info className="h-4 w-4" />
              <AlertDescription>{t('passkeys.removeLastFactor')}</AlertDescription>
            </Alert>
          )}
          <FactorProofField
            idPrefix="passkey-remove-proof"
            kinds={lastFactorProofKinds}
            codeMethod={status.mfaMethod}
            onChange={setRemoveProof}
            rejection={removeRejection}
            showMissing={removeSubmitted}
          />
        </div>
        {removeMutation.isError && (
          <p className="text-sm text-destructive" role="alert">
            {getErrorMessage(removeMutation.error, t, 'passkeys.removeFailed')}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
