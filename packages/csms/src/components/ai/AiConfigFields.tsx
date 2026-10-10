// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AI_EFFORTS,
  AI_PROVIDER_IDS,
  AI_SUPPORT_TONES,
  DEFAULT_AI_EFFORT,
  DEFAULT_AI_SUPPORT_TONE,
  isAiEffort,
  isAiProviderId,
  isAiSupportTone,
} from '@evtivity/lib/ai-config';
import type { AiEffort, AiProviderId, AiSupportTone } from '@evtivity/lib/ai-config';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { AI_STATUS_KEY } from './use-ai-status';
import { AiModelField } from './AiModelField';
import { AiSystemPromptField } from './AiSystemPromptField';
import { isCustomModel, isDefaultPrompt, useAiDefaults } from './use-ai-defaults';

/** Product names, the same in every language. */
export const PROVIDER_LABELS: Record<AiProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
};

interface SelectFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function AiProviderSelect({
  id,
  value,
  onChange,
  disabled,
  allowNone = false,
}: SelectFieldProps & { allowNone?: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    >
      {allowNone && <option value="">{t('settings.aiProviderNone')}</option>}
      {AI_PROVIDER_IDS.map((p) => (
        <option key={p} value={p}>
          {PROVIDER_LABELS[p]}
        </option>
      ))}
    </Select>
  );
}

export function AiEffortSelect({
  id,
  value,
  onChange,
  disabled,
}: SelectFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    >
      {AI_EFFORTS.map((e) => (
        <option key={e} value={e}>
          {t(`settings.aiEfforts.${e}`)}
        </option>
      ))}
    </Select>
  );
}

export function AiToneSelect({
  id,
  value,
  onChange,
  disabled,
}: SelectFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    >
      {AI_SUPPORT_TONES.map((tone) => (
        <option key={tone} value={tone}>
          {t(`settings.aiTones.${tone}`)}
        </option>
      ))}
    </Select>
  );
}

interface PersonalAiConfig {
  configured: boolean;
  provider: string | null;
  apiKey: string | null;
  model: string | null;
  effort: string | null;
  systemPrompt: string | null;
  tone?: string | null;
}

interface PersonalAiConfigCardProps {
  surface: 'chatbot' | 'support';
}

const ENDPOINTS = {
  chatbot: '/v1/users/me/chatbot-ai-config',
  support: '/v1/users/me/support-ai-config',
} as const;

/**
 * A user's own provider, key, model, effort and prompt for one AI surface
 * (`chatbot_ai_configs`). It overrides the system settings for that user.
 */
export function PersonalAiConfigCard({ surface }: PersonalAiConfigCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const endpoint = ENDPOINTS[surface];
  const queryKey = [surface === 'chatbot' ? 'chatbot-ai-config' : 'support-ai-config'];
  const idPrefix = surface === 'chatbot' ? 'ai-profile' : 'sai-profile';

  const [provider, setProvider] = useState<AiProviderId>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<AiEffort>(DEFAULT_AI_EFFORT);
  const [tone, setTone] = useState<AiSupportTone>(DEFAULT_AI_SUPPORT_TONE);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);
  const aiDefaults = useAiDefaults('personal');
  const surfaceDefaults = aiDefaults?.[surface];

  const { data: config } = useQuery({
    queryKey,
    queryFn: () => api.get<PersonalAiConfig>(endpoint),
  });

  useEffect(() => {
    if (config == null) return;
    setProvider(isAiProviderId(config.provider) ? config.provider : 'anthropic');
    setApiKey(config.apiKey ?? '');
    setModel(config.model ?? '');
    setEffort(isAiEffort(config.effort) ? config.effort : DEFAULT_AI_EFFORT);
    setTone(isAiSupportTone(config.tone) ? config.tone : DEFAULT_AI_SUPPORT_TONE);
    setSystemPrompt(config.systemPrompt ?? '');
  }, [config]);

  const save = useMutation({
    // `prompt` is the field, or empty for Reset to default.
    // An unchanged built-in prompt is not stored, so later defaults apply.
    mutationFn: (prompt: string) =>
      api.put(endpoint, {
        provider,
        apiKey: apiKey.trim(),
        effort,
        ...(model.trim() !== '' ? { model: model.trim() } : {}),
        ...(prompt.trim() !== '' && !isDefaultPrompt(prompt, surfaceDefaults)
          ? { systemPrompt: prompt }
          : {}),
        ...(surface === 'support' ? { tone } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(endpoint),
    onSuccess: () => {
      setRemoveOpen(false);
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
    },
  });

  const title = surface === 'chatbot' ? t('profile.chatbotAi') : t('profile.supportAi');
  const description =
    surface === 'chatbot' ? t('profile.chatbotAiDescription') : t('profile.supportAiDescription');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-provider`} className="leading-6">
              {t('settings.aiProvider')}
            </Label>
            <AiProviderSelect
              id={`${idPrefix}-provider`}
              value={provider}
              onChange={(v) => {
                if (!isAiProviderId(v)) return;
                // A listed model belongs to the old provider: back to the default.
                if (!isCustomModel(aiDefaults, provider, model)) setModel('');
                setProvider(v);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-api-key`} className="leading-6">
              {t('settings.aiApiKey')}
            </Label>
            <PasswordInput
              id={`${idPrefix}-api-key`}
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-model`} className="leading-6">
              {t('settings.aiModel')}
            </Label>
            <AiModelField
              key={provider}
              id={`${idPrefix}-model`}
              provider={provider}
              defaults={aiDefaults}
              value={model}
              onChange={setModel}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-effort`} className="leading-6">
              {t('settings.aiEffort')}
            </Label>
            <AiEffortSelect
              id={`${idPrefix}-effort`}
              value={effort}
              onChange={(v) => {
                if (isAiEffort(v)) setEffort(v);
              }}
            />
          </div>
          {surface === 'support' && (
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-tone`} className="leading-6">
                {t('settings.aiTone')}
              </Label>
              <AiToneSelect
                id={`${idPrefix}-tone`}
                value={tone}
                onChange={(v) => {
                  if (isAiSupportTone(v)) setTone(v);
                }}
              />
            </div>
          )}
        </div>
        <AiSystemPromptField
          id={`${idPrefix}-system-prompt`}
          defaults={surfaceDefaults}
          value={systemPrompt}
          savedValue={config?.systemPrompt ?? ''}
          onChange={setSystemPrompt}
          resetPending={save.isPending}
          onReset={() => {
            save.mutate('');
          }}
        />
        {save.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(save.error, t, 'settings.aiSaveFailed')}
          </p>
        )}
        {save.isSuccess && <p className="text-sm text-success">{t('settings.aiSaved')}</p>}
        <div className="flex justify-end gap-2">
          {config?.configured === true && (
            <Button
              variant="destructive"
              onClick={() => {
                setRemoveOpen(true);
              }}
            >
              {t('profile.aiRemoveConfig')}
            </Button>
          )}
          <SaveButton
            isPending={save.isPending}
            disabled={apiKey.trim() === ''}
            onClick={() => {
              save.mutate(systemPrompt);
            }}
          />
        </div>
        <ConfirmDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          title={t('profile.aiRemoveConfig')}
          description={t('profile.aiRemoveConfirm')}
          confirmLabel={t('common.delete')}
          variant="destructive"
          isPending={remove.isPending}
          onConfirm={() => {
            remove.mutate();
            return false;
          }}
        />
      </CardContent>
    </Card>
  );
}
