// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

interface AiSettingsProps {
  settings: Record<string, unknown> | undefined;
}

export function AiSettings({ settings }: AiSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Chatbot AI state
  const [chatbotAiEnabled, setChatbotAiEnabled] = useState(false);
  const [chatbotAiProvider, setChatbotAiProvider] = useState('anthropic');
  const [chatbotAiApiKey, setChatbotAiApiKey] = useState('');
  const [chatbotAiModel, setChatbotAiModel] = useState('');
  const [chatbotAiTemperature, setChatbotAiTemperature] = useState('');
  const [chatbotAiTopP, setChatbotAiTopP] = useState('');
  const [chatbotAiTopK, setChatbotAiTopK] = useState('');
  const [chatbotAiSystemPrompt, setChatbotAiSystemPrompt] = useState('');

  // Support AI state
  const [supportAiEnabled, setSupportAiEnabled] = useState(false);
  const [supportAiProvider, setSupportAiProvider] = useState('anthropic');
  const [supportAiApiKey, setSupportAiApiKey] = useState('');
  const [supportAiModel, setSupportAiModel] = useState('');
  const [supportAiTemperature, setSupportAiTemperature] = useState('');
  const [supportAiTopP, setSupportAiTopP] = useState('');
  const [supportAiTopK, setSupportAiTopK] = useState('');
  const [supportAiTone, setSupportAiTone] = useState('professional');
  const [supportAiSystemPrompt, setSupportAiSystemPrompt] = useState('');

  useEffect(() => {
    if (settings == null) return;
    setChatbotAiEnabled(settings['chatbotAi.enabled'] === true);
    const aip = settings['chatbotAi.provider'];
    setChatbotAiProvider(typeof aip === 'string' && aip !== '' ? aip : 'anthropic');
    setChatbotAiApiKey('');
    const aim = settings['chatbotAi.model'];
    setChatbotAiModel(typeof aim === 'string' ? aim : '');
    const ait = settings['chatbotAi.temperature'];
    setChatbotAiTemperature(
      typeof ait === 'number' ? String(ait) : typeof ait === 'string' && ait !== '' ? ait : '',
    );
    const aitp = settings['chatbotAi.topP'];
    setChatbotAiTopP(
      typeof aitp === 'number' ? String(aitp) : typeof aitp === 'string' && aitp !== '' ? aitp : '',
    );
    const aitk = settings['chatbotAi.topK'];
    setChatbotAiTopK(
      typeof aitk === 'number' ? String(aitk) : typeof aitk === 'string' && aitk !== '' ? aitk : '',
    );
    const aisp = settings['chatbotAi.systemPrompt'];
    setChatbotAiSystemPrompt(typeof aisp === 'string' ? aisp : '');
    setSupportAiEnabled(settings['supportAi.enabled'] === true);
    const saip = settings['supportAi.provider'];
    setSupportAiProvider(typeof saip === 'string' && saip !== '' ? saip : 'anthropic');
    setSupportAiApiKey('');
    const saim = settings['supportAi.model'];
    setSupportAiModel(typeof saim === 'string' ? saim : '');
    const sait = settings['supportAi.temperature'];
    setSupportAiTemperature(
      typeof sait === 'number' ? String(sait) : typeof sait === 'string' && sait !== '' ? sait : '',
    );
    const saitp = settings['supportAi.topP'];
    setSupportAiTopP(
      typeof saitp === 'number'
        ? String(saitp)
        : typeof saitp === 'string' && saitp !== ''
          ? saitp
          : '',
    );
    const saitk = settings['supportAi.topK'];
    setSupportAiTopK(
      typeof saitk === 'number'
        ? String(saitk)
        : typeof saitk === 'string' && saitk !== ''
          ? saitk
          : '',
    );
    const saitn = settings['supportAi.tone'];
    setSupportAiTone(typeof saitn === 'string' && saitn !== '' ? saitn : 'professional');
    const saisp = settings['supportAi.systemPrompt'];
    setSupportAiSystemPrompt(typeof saisp === 'string' ? saisp : '');
  }, [settings]);

  const chatbotAiToggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.put('/v1/settings/chatbotAi.enabled', { value: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const chatbotAiSaveMutation = useMutation({
    mutationFn: (vals: {
      provider: string;
      apiKey: string;
      model: string;
      temperature: string;
      topP: string;
      topK: string;
      systemPrompt: string;
    }) =>
      Promise.all([
        api.put('/v1/settings/chatbotAi.provider', { value: vals.provider }),
        ...(vals.apiKey !== ''
          ? [api.put('/v1/settings/chatbotAi.apiKeyEnc', { value: vals.apiKey })]
          : []),
        api.put('/v1/settings/chatbotAi.model', { value: vals.model }),
        api.put('/v1/settings/chatbotAi.temperature', { value: vals.temperature }),
        api.put('/v1/settings/chatbotAi.topP', { value: vals.topP }),
        api.put('/v1/settings/chatbotAi.topK', { value: vals.topK }),
        api.put('/v1/settings/chatbotAi.systemPrompt', { value: vals.systemPrompt }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const supportAiToggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.put('/v1/settings/supportAi.enabled', { value: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const supportAiSaveMutation = useMutation({
    mutationFn: (vals: {
      provider: string;
      apiKey: string;
      model: string;
      temperature: string;
      topP: string;
      topK: string;
      tone: string;
      systemPrompt: string;
    }) =>
      Promise.all([
        api.put('/v1/settings/supportAi.provider', { value: vals.provider }),
        ...(vals.apiKey !== ''
          ? [api.put('/v1/settings/supportAi.apiKeyEnc', { value: vals.apiKey })]
          : []),
        api.put('/v1/settings/supportAi.model', { value: vals.model }),
        api.put('/v1/settings/supportAi.temperature', { value: vals.temperature }),
        api.put('/v1/settings/supportAi.topP', { value: vals.topP }),
        api.put('/v1/settings/supportAi.topK', { value: vals.topK }),
        api.put('/v1/settings/supportAi.tone', { value: vals.tone }),
        api.put('/v1/settings/supportAi.systemPrompt', { value: vals.systemPrompt }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.chatbotAiSectionTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label>{t('settings.chatbotAiEnabled')}</Label>
              <p className="text-xs text-muted-foreground">{t('settings.chatbotAiEnabledDesc')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={chatbotAiEnabled}
              onClick={() => {
                setChatbotAiEnabled(!chatbotAiEnabled);
                chatbotAiToggleMutation.mutate(!chatbotAiEnabled);
              }}
              disabled={chatbotAiToggleMutation.isPending}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${chatbotAiEnabled ? 'bg-primary' : 'bg-muted'}`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${chatbotAiEnabled ? 'translate-x-5' : 'translate-x-0'}`}
              />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ai-provider">{t('settings.chatbotAiProvider')}</Label>
              <select
                id="ai-provider"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={chatbotAiProvider}
                onChange={(e) => {
                  setChatbotAiProvider(e.target.value);
                }}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-api-key">{t('settings.chatbotAiApiKey')}</Label>
              <PasswordInput
                id="ai-api-key"
                value={chatbotAiApiKey}
                onChange={(e) => {
                  setChatbotAiApiKey(e.target.value);
                }}
                placeholder={
                  settings?.['chatbotAi.apiKeyEnc'] != null &&
                  settings['chatbotAi.apiKeyEnc'] !== ''
                    ? '********'
                    : ''
                }
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-model">{t('settings.chatbotAiModel')}</Label>
            <Input
              id="ai-model"
              value={chatbotAiModel}
              onChange={(e) => {
                setChatbotAiModel(e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">{t('settings.chatbotAiModelHelp')}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ai-temperature">{t('settings.chatbotAiTemperature')}</Label>
              <Input
                id="ai-temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={chatbotAiTemperature}
                onChange={(e) => {
                  setChatbotAiTemperature(e.target.value);
                }}
                placeholder="0.7"
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.chatbotAiTemperatureHint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-top-p">{t('settings.chatbotAiTopP')}</Label>
              <Input
                id="ai-top-p"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={chatbotAiTopP}
                onChange={(e) => {
                  setChatbotAiTopP(e.target.value);
                }}
                placeholder="0.9"
              />
              <p className="text-xs text-muted-foreground">{t('settings.chatbotAiTopPHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-top-k">{t('settings.chatbotAiTopK')}</Label>
              <Input
                id="ai-top-k"
                type="number"
                min={1}
                max={100}
                step={1}
                value={chatbotAiTopK}
                onChange={(e) => {
                  setChatbotAiTopK(e.target.value);
                }}
                placeholder="40"
              />
              <p className="text-xs text-muted-foreground">{t('settings.chatbotAiTopKHint')}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-system-prompt">{t('settings.chatbotAiSystemPrompt')}</Label>
            <textarea
              id="ai-system-prompt"
              rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={chatbotAiSystemPrompt}
              onChange={(e) => {
                setChatbotAiSystemPrompt(e.target.value);
              }}
              placeholder={t('settings.chatbotAiSystemPromptDefault')}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.chatbotAiSystemPromptHint')}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <SaveButton
              isPending={chatbotAiSaveMutation.isPending}
              onClick={() => {
                chatbotAiSaveMutation.mutate({
                  provider: chatbotAiProvider,
                  apiKey: chatbotAiApiKey,
                  model: chatbotAiModel,
                  temperature: chatbotAiTemperature,
                  topP: chatbotAiTopP,
                  topK: chatbotAiTopK,
                  systemPrompt: chatbotAiSystemPrompt,
                });
              }}
            />
            {chatbotAiSaveMutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.chatbotAiSaved')}</p>
            )}
            {chatbotAiSaveMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.chatbotAiSaveFailed')}</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('settings.supportAi')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('settings.supportAiDescription')}</p>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label>{t('settings.supportAiEnabled')}</Label>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={supportAiEnabled}
              onClick={() => {
                setSupportAiEnabled(!supportAiEnabled);
                supportAiToggleMutation.mutate(!supportAiEnabled);
              }}
              disabled={supportAiToggleMutation.isPending}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${supportAiEnabled ? 'bg-primary' : 'bg-muted'}`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${supportAiEnabled ? 'translate-x-5' : 'translate-x-0'}`}
              />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="support-ai-provider">{t('settings.supportAiProvider')}</Label>
              <select
                id="support-ai-provider"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={supportAiProvider}
                onChange={(e) => {
                  setSupportAiProvider(e.target.value);
                }}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-ai-api-key">{t('settings.supportAiApiKey')}</Label>
              <PasswordInput
                id="support-ai-api-key"
                value={supportAiApiKey}
                onChange={(e) => {
                  setSupportAiApiKey(e.target.value);
                }}
                placeholder={
                  settings?.['supportAi.apiKeyEnc'] != null &&
                  settings['supportAi.apiKeyEnc'] !== ''
                    ? '********'
                    : ''
                }
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="support-ai-model">{t('settings.supportAiModel')}</Label>
            <Input
              id="support-ai-model"
              value={supportAiModel}
              onChange={(e) => {
                setSupportAiModel(e.target.value);
              }}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="support-ai-temperature">{t('settings.supportAiTemperature')}</Label>
              <Input
                id="support-ai-temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={supportAiTemperature}
                onChange={(e) => {
                  setSupportAiTemperature(e.target.value);
                }}
                placeholder="0.3"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-ai-top-p">{t('settings.supportAiTopP')}</Label>
              <Input
                id="support-ai-top-p"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={supportAiTopP}
                onChange={(e) => {
                  setSupportAiTopP(e.target.value);
                }}
                placeholder="0.9"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-ai-top-k">{t('settings.supportAiTopK')}</Label>
              <Input
                id="support-ai-top-k"
                type="number"
                min={1}
                max={100}
                step={1}
                value={supportAiTopK}
                onChange={(e) => {
                  setSupportAiTopK(e.target.value);
                }}
                placeholder="40"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="support-ai-tone">{t('settings.supportAiTone')}</Label>
            <select
              id="support-ai-tone"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={supportAiTone}
              onChange={(e) => {
                setSupportAiTone(e.target.value);
              }}
            >
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="formal">Formal</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="support-ai-system-prompt">{t('settings.supportAiSystemPrompt')}</Label>
            <textarea
              id="support-ai-system-prompt"
              rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={supportAiSystemPrompt}
              onChange={(e) => {
                setSupportAiSystemPrompt(e.target.value);
              }}
              placeholder={t('settings.supportAiSystemPromptDefault')}
            />
          </div>
          <div className="flex items-center gap-4">
            <SaveButton
              isPending={supportAiSaveMutation.isPending}
              onClick={() => {
                supportAiSaveMutation.mutate({
                  provider: supportAiProvider,
                  apiKey: supportAiApiKey,
                  model: supportAiModel,
                  temperature: supportAiTemperature,
                  topP: supportAiTopP,
                  topK: supportAiTopK,
                  tone: supportAiTone,
                  systemPrompt: supportAiSystemPrompt,
                });
              }}
            />
            {supportAiSaveMutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.supportAiSaved')}</p>
            )}
            {supportAiSaveMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.supportAiSaveFailed')}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
