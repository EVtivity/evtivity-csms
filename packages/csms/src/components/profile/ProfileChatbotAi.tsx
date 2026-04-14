// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';

interface AiConfig {
  configured: boolean;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  systemPrompt: string | null;
}

export function ProfileChatbotAi(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [chatbotAiProvider, setChatbotAiProvider] = useState('anthropic');
  const [chatbotAiApiKey, setChatbotAiApiKey] = useState('');
  const [chatbotAiModelOverride, setChatbotAiModelOverride] = useState('');
  const [chatbotAiTemperature, setChatbotAiTemperature] = useState('');
  const [chatbotAiTopP, setChatbotAiTopP] = useState('');
  const [chatbotAiTopK, setChatbotAiTopK] = useState('');
  const [chatbotAiSystemPrompt, setChatbotAiSystemPrompt] = useState('');
  const [chatbotAiRemoveOpen, setChatbotAiRemoveOpen] = useState(false);

  const { data: chatbotAiConfig } = useQuery({
    queryKey: ['chatbot-ai-config'],
    queryFn: () => api.get<AiConfig>('/v1/users/me/chatbot-ai-config'),
  });

  const [chatbotAiConfigLoaded, setChatbotAiConfigLoaded] = useState(false);
  useEffect(() => {
    if (chatbotAiConfig != null && !chatbotAiConfigLoaded) {
      if (chatbotAiConfig.configured) {
        setChatbotAiProvider(chatbotAiConfig.provider ?? 'anthropic');
        setChatbotAiModelOverride(chatbotAiConfig.model ?? '');
        setChatbotAiTemperature(
          chatbotAiConfig.temperature != null ? String(chatbotAiConfig.temperature) : '',
        );
        setChatbotAiTopP(chatbotAiConfig.topP != null ? String(chatbotAiConfig.topP) : '');
        setChatbotAiTopK(chatbotAiConfig.topK != null ? String(chatbotAiConfig.topK) : '');
        setChatbotAiSystemPrompt(chatbotAiConfig.systemPrompt ?? '');
      }
      setChatbotAiConfigLoaded(true);
    }
  }, [chatbotAiConfig, chatbotAiConfigLoaded]);

  const chatbotAiSaveMutation = useMutation({
    mutationFn: (body: {
      provider: string;
      apiKey: string;
      model?: string;
      temperature?: number;
      topP?: number;
      topK?: number;
      systemPrompt?: string;
    }) => api.put('/v1/users/me/chatbot-ai-config', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chatbot-ai-config'] });
      setChatbotAiApiKey('');
    },
  });

  const chatbotAiRemoveMutation = useMutation({
    mutationFn: () => api.delete('/v1/users/me/chatbot-ai-config'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chatbot-ai-config'] });
      setChatbotAiProvider('anthropic');
      setChatbotAiApiKey('');
      setChatbotAiModelOverride('');
      setChatbotAiTemperature('');
      setChatbotAiTopP('');
      setChatbotAiTopK('');
      setChatbotAiSystemPrompt('');
      setChatbotAiConfigLoaded(false);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.chatbotAi')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="ai-profile-provider">{t('profile.chatbotAiProvider')}</Label>
          <select
            id="ai-profile-provider"
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
          <Label htmlFor="ai-profile-api-key">{t('profile.chatbotAiApiKey')}</Label>
          <PasswordInput
            id="ai-profile-api-key"
            value={chatbotAiApiKey}
            onChange={(e) => {
              setChatbotAiApiKey(e.target.value);
            }}
            placeholder={chatbotAiConfig?.configured ? t('profile.chatbotAiApiKeyConfigured') : ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ai-profile-model">{t('profile.chatbotAiModel')}</Label>
          <Input
            id="ai-profile-model"
            value={chatbotAiModelOverride}
            onChange={(e) => {
              setChatbotAiModelOverride(e.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">{t('profile.chatbotAiModelHelp')}</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ai-profile-temperature">{t('profile.chatbotAiTemperature')}</Label>
            <Input
              id="ai-profile-temperature"
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
            <Label htmlFor="ai-profile-top-p">{t('profile.chatbotAiTopP')}</Label>
            <Input
              id="ai-profile-top-p"
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
            <Label htmlFor="ai-profile-top-k">{t('profile.chatbotAiTopK')}</Label>
            <Input
              id="ai-profile-top-k"
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
          <Label htmlFor="ai-profile-system-prompt">{t('profile.chatbotAiSystemPrompt')}</Label>
          <textarea
            id="ai-profile-system-prompt"
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={chatbotAiSystemPrompt}
            onChange={(e) => {
              setChatbotAiSystemPrompt(e.target.value);
            }}
            placeholder="You are an EV charging station management assistant. Answer questions about stations, sessions, energy, revenue, and operations. Use the provided tools to fetch real-time data. Format numbers with commas, currency from cents to dollars, energy from Wh to kWh. Use markdown tables for tabular data. Be concise and direct. Before making any changes, ask the user for explicit confirmation. Never reveal passwords, API keys, secret keys, encryption keys, tokens, or credentials."
          />
          <p className="text-xs text-muted-foreground">{t('settings.chatbotAiSystemPromptHint')}</p>
        </div>
        <div className="flex gap-2">
          <SaveButton
            isPending={chatbotAiSaveMutation.isPending}
            onClick={() => {
              if (chatbotAiApiKey === '' && !chatbotAiConfig?.configured) return;
              chatbotAiSaveMutation.mutate({
                provider: chatbotAiProvider,
                apiKey: chatbotAiApiKey,
                ...(chatbotAiModelOverride !== '' ? { model: chatbotAiModelOverride } : {}),
                ...(chatbotAiTemperature !== ''
                  ? { temperature: Number(chatbotAiTemperature) }
                  : {}),
                ...(chatbotAiTopP !== '' ? { topP: Number(chatbotAiTopP) } : {}),
                ...(chatbotAiTopK !== '' ? { topK: Number(chatbotAiTopK) } : {}),
                ...(chatbotAiSystemPrompt !== '' ? { systemPrompt: chatbotAiSystemPrompt } : {}),
              });
            }}
          />
          {chatbotAiConfig?.configured && (
            <Button
              variant="destructive"
              onClick={() => {
                setChatbotAiRemoveOpen(true);
              }}
            >
              {t('profile.chatbotAiRemoveConfig')}
            </Button>
          )}
        </div>
        <ConfirmDialog
          open={chatbotAiRemoveOpen}
          onOpenChange={setChatbotAiRemoveOpen}
          title={t('profile.chatbotAiRemoveConfig')}
          description={t('profile.chatbotAiRemoveConfirm')}
          confirmLabel={t('common.delete')}
          variant="destructive"
          isPending={chatbotAiRemoveMutation.isPending}
          onConfirm={() => {
            chatbotAiRemoveMutation.mutate();
          }}
        />
      </CardContent>
    </Card>
  );
}
