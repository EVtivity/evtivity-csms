// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Shuffle, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DriverAvatar } from '@/components/account/DriverAvatar';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { cn } from '@/lib/utils';
import { AVATAR_QUERY_KEY, uploadAvatarImage, type DriverAvatar as Avatar } from '@/lib/avatar';

type AvatarLib = typeof import('@evtivity/lib/account-avatar');
type Generated = Extract<Avatar, { kind: 'generated' }>;

/** A generated avatar as the API takes it. */
export type GeneratedAvatarChoice = Pick<Generated, 'style' | 'seed' | 'options'>;

/** The avatar module (DiceBear and the shared rules), loaded on demand out of the first bundle. */
function useAvatarLib(): AvatarLib | null {
  const [lib, setLib] = useState<AvatarLib | null>(null);
  useEffect(() => {
    let active = true;
    void import('@evtivity/lib/account-avatar').then((mod) => {
      if (active) setLib(mod);
    });
    return () => {
      active = false;
    };
  }, []);
  return lib;
}

export interface AvatarEditorProps {
  /** The saved avatar (live) or the current choice (deferred): the editor starts from it. */
  current: Avatar | null | undefined;
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  /**
   * live: saves through the portal avatar API (generator, upload, remove).
   * deferred: no request; Save and Remove hand the choice to `onChoose` (generator only),
   * for the registration form, which sends it with the new account.
   */
  mode: 'live' | 'deferred';
  /** Deferred mode: the chosen avatar, or null when the choice is removed. */
  onChoose?: (avatar: GeneratedAvatarChoice | null) => void;
  /** Called after a save, an upload, a removal or Cancel. */
  onDone: () => void;
}

/**
 * The portal avatar editor: a DiceBear Avataaars builder (option dropdowns
 * with None, colors, Random) or, in live mode with file storage, a photo
 * upload (JPEG, PNG or WebP smaller than 1 MB, checked here before any
 * request), and Remove. The rules come from `@evtivity/lib/account-avatar`.
 */
export function AvatarEditor({
  current,
  firstName,
  lastName,
  mode,
  onChoose,
  onDone,
}: AvatarEditorProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const lib = useAvatarLib();
  const live = mode === 'live';
  const { data: features } = useQuery({
    queryKey: ['portal-features'],
    queryFn: () => api.get<{ avatarUploadEnabled?: boolean }>('/v1/portal/features'),
    staleTime: 5 * 60_000,
    enabled: live,
  });
  const uploadEnabled = live && features?.avatarUploadEnabled === true;

  const [tab, setTab] = useState<'create' | 'upload'>('create');
  const [draft, setDraft] = useState<Generated | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Start from the saved generated avatar, else a random one (also for one off the allow-list).
  useEffect(() => {
    if (draft != null || lib == null) return;
    setDraft({ kind: 'generated', updatedAt: null, ...lib.editableGeneratedAvatar(current) });
  }, [lib, current, draft]);

  function stored(avatar: Avatar | null): void {
    queryClient.setQueryData(AVATAR_QUERY_KEY, avatar);
    void queryClient.invalidateQueries({ queryKey: AVATAR_QUERY_KEY });
  }

  async function run(action: () => Promise<Avatar | null>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      stored(await action());
      onDone();
      return true;
    } catch (err) {
      setError(getErrorMessage(err, t, 'account.avatarSaveFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function setOption(key: string, value: string | number): void {
    setDraft((d) => (d == null ? d : { ...d, options: { ...d.options, [key]: value } }));
  }

  /** A dropdown pick: None stores the component's probability 0, a variant stores 100. */
  function selectVariant(key: string, value: string): void {
    if (lib == null) return;
    setDraft((d) =>
      d == null ? d : { ...d, options: lib.withAvatarVariantSelection(d.options, key, value) },
    );
  }

  function save(): void {
    if (draft == null) return;
    const choice = { style: draft.style, seed: draft.seed, options: draft.options };
    if (!live) {
      onChoose?.(choice);
      onDone();
      return;
    }
    void run(async () => {
      const res = await api.put<{ avatar: Avatar | null }>('/v1/portal/driver/avatar', choice);
      return res.avatar;
    });
  }

  function onFile(file: File | undefined): void {
    if (file == null || lib == null) return;
    const problem = lib.avatarFileProblem(file);
    if (problem != null) {
      setError(t(problem === 'too_large' ? 'account.avatarTooLarge' : 'account.avatarWrongType'));
      return;
    }
    void run(() => uploadAvatarImage(file));
  }

  function remove(): Promise<boolean> | undefined {
    if (!live) {
      onChoose?.(null);
      onDone();
      return undefined;
    }
    return run(async () => {
      await api.delete('/v1/portal/driver/avatar');
      return null;
    });
  }

  const preview: Avatar | null | undefined = tab === 'create' ? draft : current;
  const choices = lib?.avatarOptionChoices() ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3">
        <DriverAvatar
          avatar={preview}
          firstName={firstName}
          lastName={lastName}
          size="lg"
          className="h-28 w-28 text-4xl"
        />
        {uploadEnabled && (
          <div className="inline-flex rounded-md border p-1" role="group">
            {(['create', 'upload'] as const).map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={tab === m ? 'default' : 'ghost'}
                aria-pressed={tab === m}
                onClick={() => {
                  setTab(m);
                  setError(null);
                }}
              >
                {t(m === 'create' ? 'account.avatarCreate' : 'account.avatarUpload')}
              </Button>
            ))}
          </div>
        )}
      </div>

      {tab === 'create' &&
        (lib == null || draft == null ? (
          <div className="flex justify-center py-6">
            <Spinner className="h-6 w-6" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {choices
                .filter((c) => c.kind === 'enum')
                .map((choice) => (
                  <label key={choice.key} className="space-y-1 text-sm font-medium">
                    <span>{t(`account.avatarOptions.${choice.key}`)}</span>
                    <Select
                      value={lib.avatarVariantSelection(draft.options, choice.key)}
                      onChange={(e) => {
                        selectVariant(choice.key, e.target.value);
                      }}
                    >
                      {lib.avatarVariantHasNone(choice.key) && (
                        <option value={lib.AVATAR_NONE_VALUE}>
                          {t(`account.avatarNone.${choice.key}`)}
                        </option>
                      )}
                      {choice.values.map((value) => (
                        <option key={value} value={value}>
                          {choice.key === 'flip'
                            ? t(`account.avatarValues.${value}`)
                            : lib.humanizeAvatarValue(value)}
                        </option>
                      ))}
                    </Select>
                  </label>
                ))}
            </div>

            {choices
              .filter((c) => c.kind === 'color' && lib.avatarColorShown(draft.options, c.key))
              .map((choice) => (
                <fieldset key={choice.key} className="space-y-1">
                  <legend className="text-sm font-medium">
                    {t(`account.avatarOptions.${choice.key}`)}
                  </legend>
                  <div className="flex flex-wrap gap-2" role="radiogroup">
                    {choice.values.map((color) => {
                      const selected = draft.options[choice.key] === color;
                      return (
                        <button
                          key={color}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={`#${color}`}
                          className={cn(
                            'h-8 w-8 rounded-full border',
                            selected && 'ring-2 ring-ring ring-offset-2',
                          )}
                          style={{ backgroundColor: `#${color}` }}
                          onClick={() => {
                            setOption(choice.key, color);
                          }}
                        />
                      );
                    })}
                  </div>
                </fieldset>
              ))}
          </div>
        ))}

      {tab === 'upload' && uploadEnabled && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('account.avatarUploadHint')}</p>
          <input
            ref={fileInput}
            type="file"
            accept={lib?.AVATAR_MIME_TYPES.join(',')}
            className="hidden"
            data-testid="avatar-file"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            className="w-full"
            disabled={busy || lib == null}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? <Spinner className="mr-2 h-4 w-4" /> : <Upload className="mr-2 h-4 w-4" />}
            {t('account.avatarChooseImage')}
          </Button>
        </div>
      )}

      {error != null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {current != null && (
          <Button
            type="button"
            variant="outline"
            className="mr-auto text-destructive"
            disabled={busy}
            onClick={() => {
              if (live) setRemoveOpen(true);
              else void remove();
            }}
          >
            {t('account.avatarRemove')}
          </Button>
        )}
        <Button type="button" variant="outline" disabled={busy} onClick={onDone}>
          {t('common.cancel')}
        </Button>
        {tab === 'create' && lib != null && draft != null && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft({ kind: 'generated', updatedAt: null, ...lib.randomGeneratedAvatar() });
              }}
            >
              <Shuffle className="mr-2 h-4 w-4" />
              {t('account.avatarRandom')}
            </Button>
            <Button type="button" disabled={busy} onClick={save}>
              {busy && <Spinner className="mr-2 h-4 w-4" />}
              {t('common.save')}
            </Button>
          </>
        )}
      </div>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t('account.avatarRemoveTitle')}
        description={t('account.avatarRemoveDescription')}
        confirmLabel={t('account.avatarRemove')}
        variant="destructive"
        isPending={busy}
        onConfirm={remove}
      />
    </div>
  );
}

/** The editor in an overlay, the same pattern as the portal confirm dialog. */
export function AvatarEditorDialog({
  open,
  title,
  ...editor
}: AvatarEditorProps & { open: boolean; title: string }): React.JSX.Element | null {
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="fixed inset-0 bg-background/80 backdrop-blur-xs" onClick={editor.onDone} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-40 mx-4 max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-lg border bg-card p-6 shadow-lg"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <AvatarEditor {...editor} />
      </div>
    </div>
  );
}

/**
 * A form field: the avatar with an Edit button that opens the editor. Live in the
 * profile form; deferred on the registration form (the choice goes with the account).
 */
export function AvatarField({
  avatar,
  firstName,
  lastName,
  mode,
  onChoose,
}: {
  avatar: Avatar | null | undefined;
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  mode: 'live' | 'deferred';
  onChoose?: (avatar: GeneratedAvatarChoice | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium leading-6">
        {t(mode === 'live' ? 'account.avatar' : 'auth.avatarOptional')}
      </span>
      <div className="flex items-center gap-4">
        <DriverAvatar avatar={avatar} firstName={firstName} lastName={lastName} size="lg" />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('account.editAvatar')}
        </Button>
      </div>
      <AvatarEditorDialog
        open={open}
        title={t('account.editAvatar')}
        current={avatar}
        firstName={firstName}
        lastName={lastName}
        mode={mode}
        {...(onChoose != null ? { onChoose } : {})}
        onDone={() => {
          setOpen(false);
        }}
      />
    </div>
  );
}
