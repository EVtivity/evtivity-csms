// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { isCustomModel, providerModels } from './use-ai-defaults';
import type { AiDefaults } from './use-ai-defaults';

const CUSTOM = '__custom__';

interface AiModelFieldProps {
  id: string;
  provider: string;
  /** Stored model id; empty means the provider's default model. */
  value: string;
  onChange: (value: string) => void;
  defaults: AiDefaults | undefined;
  disabled?: boolean;
}

/**
 * Model picker: the registry models of the selected provider (the default
 * marked, stored as an empty value so a later default applies), plus a
 * custom id for models the registry does not know yet, and a link to the
 * provider's models page. Render it with `key={provider}` so a provider
 * switch starts from the list again.
 */
export function AiModelField({
  id,
  provider,
  value,
  onChange,
  defaults,
  disabled,
}: AiModelFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  const entry = providerModels(defaults, provider);
  const [customPicked, setCustomPicked] = useState(false);

  if (entry == null) {
    return (
      <>
        <Input
          id={id}
          disabled={disabled}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
        <p className="text-xs text-muted-foreground">{t('settings.aiModelHint')}</p>
      </>
    );
  }

  const custom = customPicked || isCustomModel(defaults, provider, value);
  const listed = value.trim() === '' || value.trim() === entry.defaultModel ? '' : value.trim();
  const selectValue = custom ? CUSTOM : listed;

  return (
    <>
      <Select
        id={id}
        value={selectValue}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (next === CUSTOM) {
            setCustomPicked(true);
            onChange('');
            return;
          }
          setCustomPicked(false);
          onChange(next);
        }}
      >
        {entry.models.map((m) =>
          m.id === entry.defaultModel ? (
            <option key={m.id} value="">
              {t('settings.aiModelDefaultOption', { name: m.name })}
            </option>
          ) : (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ),
        )}
        <option value={CUSTOM}>{t('settings.aiModelCustomOption')}</option>
      </Select>
      {custom && (
        <Input
          id={`${id}-custom`}
          aria-label={t('settings.aiModelCustomOption')}
          placeholder={t('settings.aiModelCustomPlaceholder')}
          disabled={disabled}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      )}
      <a
        href={entry.modelsDocsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        {t('settings.aiModelDocsLink')}
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>
    </>
  );
}
