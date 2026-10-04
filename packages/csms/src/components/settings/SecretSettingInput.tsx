// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';

/**
 * A write-only secret setting (`*Enc`). The API never returns the value, only
 * whether one is stored: a typed value replaces it, `clear` removes it, and
 * neither keeps it.
 */
export interface SecretFieldState {
  value: string;
  clear: boolean;
}

export const EMPTY_SECRET: SecretFieldState = { value: '', clear: false };

/** The body value for a secret: '' clears, a typed value replaces, undefined keeps. */
export function secretPayload(state: SecretFieldState): string | undefined {
  if (state.clear) return '';
  return state.value !== '' ? state.value : undefined;
}

export function isSecretChanged(state: SecretFieldState): boolean {
  return secretPayload(state) !== undefined;
}

interface SecretSettingInputProps {
  id: string;
  label: string;
  hint?: string;
  configured: boolean;
  state: SecretFieldState;
  onChange: (state: SecretFieldState) => void;
  canWrite: boolean;
  invalid?: boolean;
}

export function SecretSettingInput({
  id,
  label,
  hint,
  configured,
  state,
  onChange,
  canWrite,
  invalid = false,
}: SecretSettingInputProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id} className="leading-6">
          {label}
        </Label>
        <Badge variant={configured ? 'success' : 'outline'}>
          {configured ? t('settings.secretConfigured') : t('settings.secretNotConfigured')}
        </Badge>
      </div>
      {state.clear ? (
        <div className="flex h-10 items-center justify-between gap-2 rounded-md border border-dashed px-3">
          <p className="text-sm text-muted-foreground">{t('settings.secretWillClear')}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(EMPTY_SECRET);
            }}
          >
            {t('settings.secretUndoClear')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <PasswordInput
              id={id}
              value={state.value}
              disabled={!canWrite}
              autoComplete="off"
              placeholder={configured ? t('settings.secretReplacePlaceholder') : ''}
              className={invalid ? 'border-destructive' : ''}
              onChange={(e) => {
                onChange({ value: e.target.value, clear: false });
              }}
            />
          </div>
          {canWrite && configured && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onChange({ value: '', clear: true });
              }}
            >
              {t('settings.secretClear')}
            </Button>
          )}
        </div>
      )}
      {hint != null && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
