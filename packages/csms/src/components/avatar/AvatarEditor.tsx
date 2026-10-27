// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shuffle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { FileUploadButton } from '@/components/ui/file-upload-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SaveButton } from '@/components/save-button';
import { CancelButton } from '@/components/cancel-button';
import { RemoveButton } from '@/components/remove-button';
import { AccountAvatar, type AvatarData } from '@/components/AccountAvatar';
import { getErrorMessage } from '@/lib/error-message';
import type { AvatarChoice } from '@/lib/avatar';
import { cn } from '@/lib/utils';

type AvatarLib = typeof import('@evtivity/lib/account-avatar');
type Generated = import('@evtivity/lib/account-avatar').GeneratedAvatar;

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

const FILE_MESSAGES = {
  wrong_type: 'avatar.wrongType',
  too_large: 'avatar.tooLarge',
} as const;

export interface AvatarEditorProps {
  /** The current avatar. */
  avatar: AvatarData | null | undefined;
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  /**
   * Stores the choice. A rejection shows its message and keeps the editor
   * open; success closes it (`onDone`).
   */
  onSave: (choice: AvatarChoice) => Promise<void>;
  /** Called after a save, a removal or a cancel. */
  onDone: () => void;
}

/**
 * The CSMS avatar editor (Profile page, user and driver edit forms, New pages): a DiceBear Avataaars builder with Random and None options, a
 * photo upload (JPEG, PNG or WebP smaller than 1 MB, checked here before any
 * request) and Remove. The option lists, the allow-list and the file check
 * come from `@evtivity/lib/account-avatar`, shared with the portal and the API.
 */
export function AvatarEditor({
  avatar,
  firstName,
  lastName,
  onSave,
  onDone,
}: AvatarEditorProps): React.JSX.Element {
  const { t } = useTranslation();
  const lib = useAvatarLib();
  const [mode, setMode] = useState<'create' | 'upload'>('create');
  const [draft, setDraft] = useState<Generated | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  // Start from the saved generated avatar, else a random one.
  useEffect(() => {
    if (lib != null && draft == null) setDraft(lib.editableGeneratedAvatar(avatar));
  }, [lib, avatar, draft]);

  async function run(choice: AvatarChoice): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onSave(choice);
      onDone();
    } catch (err) {
      setError(getErrorMessage(err, t, 'avatar.saveFailed'));
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

  function upload(file: File | undefined): void {
    if (file == null || lib == null) return;
    const problem = lib.avatarFileProblem(file);
    if (problem != null) {
      setError(t(FILE_MESSAGES[problem]));
      return;
    }
    void run({ kind: 'image', file });
  }

  const preview: AvatarData | null | undefined =
    mode === 'create' ? (draft == null ? null : { kind: 'generated', ...draft }) : avatar;
  const choices = lib?.avatarOptionChoices() ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3">
        <AccountAvatar
          avatar={preview}
          firstName={firstName}
          lastName={lastName}
          size="lg"
          className="h-28 w-28 text-3xl"
        />
        <div className="inline-flex rounded-md border p-1" role="group">
          {(['create', 'upload'] as const).map((m) => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant={mode === m ? 'default' : 'ghost'}
              aria-pressed={mode === m}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
            >
              {t(m === 'create' ? 'avatar.create' : 'avatar.upload')}
            </Button>
          ))}
        </div>
      </div>

      {lib == null || draft == null ? (
        <div className="flex justify-center py-6">
          <Spinner className="h-6 w-6" />
        </div>
      ) : mode === 'create' ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {choices
              .filter((c) => c.kind === 'enum')
              .map((choice) => (
                <label key={choice.key} className="space-y-1 text-sm font-medium">
                  <span>{t(`avatar.options.${choice.key}`, { defaultValue: choice.key })}</span>
                  <Select
                    value={lib.avatarVariantSelection(draft.options, choice.key)}
                    onChange={(e) => {
                      selectVariant(choice.key, e.target.value);
                    }}
                  >
                    {lib.avatarVariantHasNone(choice.key) && (
                      <option value={lib.AVATAR_NONE_VALUE}>
                        {t(`avatar.none.${choice.key}`, { defaultValue: choice.key })}
                      </option>
                    )}
                    {choice.values.map((value) => (
                      <option key={value} value={value}>
                        {choice.key === 'flip'
                          ? t(`avatar.values.${value}`, { defaultValue: value })
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
                  {t(`avatar.options.${choice.key}`, { defaultValue: choice.key })}
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
                          'h-7 w-7 rounded-full border',
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
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('avatar.uploadHint')}</p>
          <FileUploadButton
            accept={lib.AVATAR_MIME_TYPES.join(',')}
            disabled={busy}
            onFiles={(files) => {
              upload(files[0]);
            }}
            data-testid="avatar-file"
          >
            {t('avatar.chooseImage')}
          </FileUploadButton>
        </div>
      )}

      {error != null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {avatar != null && (
          <RemoveButton
            label={t('avatar.remove')}
            disabled={busy}
            onClick={() => {
              setRemoveOpen(true);
            }}
          />
        )}
        <CancelButton onClick={onDone} />
        {mode === 'create' && lib != null && draft != null && (
          <>
            <Button
              type="button"
              variant="outline"
              className="gap-1.5"
              disabled={busy}
              onClick={() => {
                setDraft(lib.randomGeneratedAvatar());
              }}
            >
              <Shuffle className="h-4 w-4" />
              {t('avatar.random')}
            </Button>
            <SaveButton
              type="button"
              isPending={busy}
              onClick={() => {
                void run({ kind: 'generated', avatar: draft });
              }}
            />
          </>
        )}
      </div>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t('avatar.removeConfirmTitle')}
        description={t('avatar.removeConfirm')}
        confirmLabel={t('avatar.remove')}
        isPending={busy}
        onConfirm={() => {
          void run({ kind: 'remove' });
        }}
      />
    </div>
  );
}
