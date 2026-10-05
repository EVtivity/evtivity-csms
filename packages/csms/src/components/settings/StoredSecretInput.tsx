// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { isHiddenSecret, type StoredSecret } from './stored-secret';

interface StoredSecretInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  secret: StoredSecret;
  /** Remove the hidden stored value on save. */
  removing: boolean;
  onRemovingChange: (removing: boolean) => void;
  canWrite: boolean;
  /** Shown when the value is not hidden (unset, or returned by the GET). */
  hint: string;
  className?: string;
}

/**
 * A secret field of the payment provider settings. When the GET returned the
 * value it is prefilled; when a value is stored but hidden from this user
 * (no `settings.system:read`) the field starts empty, says a value is stored,
 * and offers an explicit remove, so saving an empty field never clears it.
 */
export function StoredSecretInput({
  id,
  value,
  onChange,
  secret,
  removing,
  onRemovingChange,
  canWrite,
  hint,
  className,
}: StoredSecretInputProps): React.JSX.Element {
  const { t } = useTranslation();
  const hidden = isHiddenSecret(secret);

  return (
    <>
      <PasswordInput
        id={id}
        value={value}
        disabled={!canWrite || removing}
        autoComplete="off"
        placeholder={hidden && !removing ? t('settings.secretStoredPlaceholder') : undefined}
        className={className}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
      {!hidden ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : removing ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-warning">{t('settings.secretRemovePending')}</p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => {
              onRemovingChange(false);
            }}
          >
            {t('settings.secretRemoveUndo')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">{t('settings.secretStoredHint')}</p>
          {canWrite && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => {
                onChange('');
                onRemovingChange(true);
              }}
            >
              {t('settings.secretRemove')}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
