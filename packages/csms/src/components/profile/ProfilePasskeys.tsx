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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CancelButton } from '@/components/cancel-button';
import { EditIconButton } from '@/components/edit-icon-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
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
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { passkeyDefaultNameKey, passkeyErrorText, webauthnSupported } from '@/lib/webauthn';
import { RecoveryCodesDisplay } from './RecoveryCodesDisplay';
import { MFA_STATUS_KEY, PASSKEYS_KEY, useMfaStatus } from './mfa-status';

/** GET /v1/users/me/webauthn. */
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
    '/v1/users/me/webauthn/registration-options',
    {},
  );
}

function nameError(name: string, t: (key: 'validation.required') => string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return t('validation.required');
  return trimmed.length > NAME_MAX ? 'max' : null;
}

/**
 * Proof, then the browser prompt, then the registration. The credential gets
 * its default name ("Passkey" or "Security Key") in the user's language; the
 * next step lets the user pick another.
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
      const reply = await api.post<RegistrationReply>('/v1/users/me/webauthn/registration', {
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
        <CancelButton onClick={onCancel} />
      </div>
    </form>
  );
}

/** Names the credential just registered; Skip keeps the default name. */
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
      api.patch<PasskeyCredential>(`/v1/users/me/webauthn/${String(credential.id)}`, {
        name: value,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      onDone();
    },
  });

  const invalid = nameError(name, t);
  const errorText = invalid === 'max' ? t('validation.maxLength', { max: NAME_MAX }) : invalid;

  return (
    <form
      noValidate
      className="space-y-4 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setHasSubmitted(true);
        if (invalid != null) return;
        // The default name is already stored: only a name the user picked needs saving.
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
        <Label htmlFor="passkey-new-name" className="leading-6">
          {t('passkeys.nameLabel')}
        </Label>
        <Input
          id="passkey-new-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            mutation.reset();
          }}
          className={hasSubmitted && errorText != null ? 'border-destructive' : ''}
        />
        <p className="text-xs text-muted-foreground">{t('passkeys.nameHint')}</p>
        {hasSubmitted && errorText != null && (
          <p className="text-sm text-destructive" role="alert">
            {errorText}
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
 * Profile > Two-Factor Authentication: the passkeys and security keys of the
 * signed-in user. Add asks for the fresh proof the account needs, then the
 * browser prompt, then a name; a first factor shows the recovery codes once.
 */
export function ProfilePasskeys(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const timezone = useUserTimezone();
  const supported = webauthnSupported();
  const { data: status } = useMfaStatus();
  const {
    data: credentials,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: PASSKEYS_KEY,
    queryFn: () => api.get<PasskeyCredential[]>('/v1/users/me/webauthn'),
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
  const enabled = status?.webauthnEnabled !== false;
  // The server's rule: no email, SMS or TOTP method and one passkey.
  const lastFactor = status?.lastFactorIsPasskey === true;
  const lastFactorProofKinds = status?.lastFactorProofKinds ?? [];
  const lockedByPolicy = lastFactor && status.requiredByPolicy === true;

  function refreshAll(): void {
    void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
    void queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
  }

  const renameMutation = useMutation({
    mutationFn: (vars: { id: number; name: string }) =>
      api.patch<PasskeyCredential>(`/v1/users/me/webauthn/${String(vars.id)}`, {
        name: vars.name,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      setRenameTarget(null);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (vars: { id: number; proof?: FactorProof }) =>
      api.delete(
        `/v1/users/me/webauthn/${String(vars.id)}`,
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
  const renameErrorText =
    renameInvalid === 'max' ? t('validation.maxLength', { max: NAME_MAX }) : renameInvalid;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('passkeys.title')}</CardTitle>
        <CardDescription>
          {t(
            status?.passkeyLoginEnabled === true
              ? 'passkeys.descriptionWithSignIn'
              : 'passkeys.description',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
            <p className="text-sm text-destructive">{t('common.loadError')}</p>
            <Button
              variant="outline"
              onClick={() => {
                void refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : list.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">{t('passkeys.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('passkeys.columns.name')}</TableHead>
                  <TableHead>{t('passkeys.columns.type')}</TableHead>
                  <TableHead>{t('passkeys.columns.created')}</TableHead>
                  <TableHead>{t('passkeys.columns.lastUsed')}</TableHead>
                  <TableHead className="text-right">{t('passkeys.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((c) => (
                  <TableRow key={c.id} data-testid={`passkey-row-${String(c.id)}`}>
                    <TableCell className="font-medium wrap-anywhere">{c.name}</TableCell>
                    <TableCell>{t(passkeyTypeKey(c))}</TableCell>
                    <TableCell>{formatDateTime(c.createdAt, timezone)}</TableCell>
                    <TableCell>
                      {c.lastUsedAt != null
                        ? formatDateTime(c.lastUsedAt, timezone)
                        : t('common.never')}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <EditIconButton
                          title={t('passkeys.rename')}
                          onClick={() => {
                            renameMutation.reset();
                            setRenameValue(c.name);
                            setRenameSubmitted(false);
                            setRenameTarget(c);
                          }}
                        />
                        <RemoveIconButton
                          title={t('passkeys.remove')}
                          disabled={lockedByPolicy}
                          onClick={() => {
                            removeMutation.reset();
                            setRemoveProof(null);
                            setRemoveRejection(null);
                            setRemoveSubmitted(false);
                            setRemoveTarget(c);
                          }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {lockedByPolicy && (
          <p className="text-sm text-muted-foreground">{t('passkeys.lastFactorRequired')}</p>
        )}
        {newCodes != null ? (
          <div className="max-w-md">
            <RecoveryCodesDisplay
              codes={newCodes}
              onDone={() => {
                setNewCodes(null);
              }}
            />
          </div>
        ) : justAdded != null ? (
          <div className="max-w-md">
            <NamePasskeyForm
              credential={justAdded.credential}
              onDone={() => {
                const codes = justAdded.recoveryCodes;
                setJustAdded(null);
                if (codes != null && codes.length > 0) setNewCodes(codes);
              }}
            />
          </div>
        ) : adding ? (
          <div className="max-w-md">
            <AddPasskeyPanel
              proofKinds={status?.factorProofKinds ?? []}
              codeMethod={status?.mfaMethod ?? null}
              onCancel={() => {
                setAdding(false);
              }}
              onRegistered={(reply) => {
                setAdding(false);
                setJustAdded(reply);
                refreshAll();
              }}
            />
          </div>
        ) : (
          supported &&
          enabled && (
            <Button
              variant="outline"
              onClick={() => {
                setAdding(true);
              }}
            >
              {t('passkeys.add')}
            </Button>
          )
        )}
      </CardContent>
      <ConfirmDialog
        open={renameTarget != null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        title={t('passkeys.renameTitle')}
        description={t('passkeys.renameDescription')}
        confirmLabel={t('common.save')}
        variant="default"
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
          <Label htmlFor="passkey-rename" className="leading-6">
            {t('passkeys.nameLabel')}
          </Label>
          <Input
            id="passkey-rename"
            value={renameValue}
            onChange={(e) => {
              setRenameValue(e.target.value);
              renameMutation.reset();
            }}
            className={renameSubmitted && renameErrorText != null ? 'border-destructive' : ''}
          />
          {renameSubmitted && renameErrorText != null && (
            <p className="text-sm text-destructive" role="alert">
              {renameErrorText}
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
            codeMethod={status?.mfaMethod ?? null}
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
    </Card>
  );
}
