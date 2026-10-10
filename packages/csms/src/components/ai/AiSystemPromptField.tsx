// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoNote } from '@/components/ui/info-note';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AiSurfaceDefaults } from './use-ai-defaults';

interface AiSystemPromptFieldProps {
  id: string;
  /** The custom prompt being edited; empty means the built-in prompt. */
  value: string;
  onChange: (value: string) => void;
  /** The saved custom prompt, to know whether a reset needs a save. */
  savedValue: string;
  /** Clears the saved custom prompt (saves an empty value). */
  onReset: () => void;
  defaults: AiSurfaceDefaults | undefined;
  disabled?: boolean;
  resetPending?: boolean;
}

/**
 * System prompt with its built-in default. With no custom prompt the field
 * shows the built-in prompt for the UI language, read-only and marked
 * Default; Edit copies it into the field as a starting point. Reset to
 * default clears the custom prompt. The rules the engine always adds are
 * shown on demand and cannot be edited.
 */
export function AiSystemPromptField({
  id,
  value,
  onChange,
  savedValue,
  onReset,
  defaults,
  disabled = false,
  resetPending = false,
}: AiSystemPromptFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  const custom = value !== '';
  const textClass = 'min-h-[120px]';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label htmlFor={id} className="leading-6">
            {t('settings.aiSystemPrompt')}
          </Label>
          {!custom && <Badge variant="secondary">{t('settings.aiPromptDefaultBadge')}</Badge>}
        </div>
        {!disabled && (
          <div className="flex gap-2">
            {!custom && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={defaults == null}
                onClick={() => {
                  onChange(defaults?.prompt ?? '');
                }}
              >
                {t('common.edit')}
              </Button>
            )}
            {(custom || savedValue !== '') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={resetPending}
                onClick={() => {
                  onChange('');
                  if (savedValue !== '') onReset();
                }}
              >
                {t('settings.aiPromptReset')}
              </Button>
            )}
          </div>
        )}
      </div>
      {custom ? (
        <Textarea
          id={id}
          rows={6}
          maxLength={8000}
          disabled={disabled}
          className={textClass}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      ) : (
        <Textarea
          id={id}
          rows={6}
          readOnly
          className={`${textClass} bg-muted text-muted-foreground`}
          value={defaults?.prompt ?? ''}
        />
      )}
      <p className="text-xs text-muted-foreground">
        {custom ? t('settings.aiSystemPromptHint') : t('settings.aiPromptDefaultHint')}
      </p>
      <InfoNote>{t('settings.aiFixedRulesNote')}</InfoNote>
      {defaults != null && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {t('settings.aiFixedRulesShow')}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-md border bg-muted p-3 font-mono text-xs">
            {defaults.fixedRules}
          </pre>
        </details>
      )}
    </div>
  );
}
