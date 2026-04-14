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

interface SupportAiConfig {
  configured: boolean;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  tone: string | null;
  systemPrompt: string | null;
}

export function ProfileSupportAi(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [saiProvider, setSaiProvider] = useState('anthropic');
  const [saiApiKey, setSaiApiKey] = useState('');
  const [saiModelOverride, setSaiModelOverride] = useState('');
  const [saiTemperature, setSaiTemperature] = useState('');
  const [saiTopP, setSaiTopP] = useState('');
  const [saiTopK, setSaiTopK] = useState('');
  const [saiTone, setSaiTone] = useState('professional');
  const [saiSystemPrompt, setSaiSystemPrompt] = useState('');
  const [saiRemoveOpen, setSaiRemoveOpen] = useState(false);

  const { data: saiConfig } = useQuery({
    queryKey: ['support-ai-config'],
    queryFn: () => api.get<SupportAiConfig>('/v1/users/me/support-ai-config'),
  });

  const [saiConfigLoaded, setSaiConfigLoaded] = useState(false);
  useEffect(() => {
    if (saiConfig != null && !saiConfigLoaded) {
      if (saiConfig.configured) {
        setSaiProvider(saiConfig.provider ?? 'anthropic');
        setSaiModelOverride(saiConfig.model ?? '');
        setSaiTemperature(saiConfig.temperature != null ? String(saiConfig.temperature) : '');
        setSaiTopP(saiConfig.topP != null ? String(saiConfig.topP) : '');
        setSaiTopK(saiConfig.topK != null ? String(saiConfig.topK) : '');
        setSaiTone(saiConfig.tone ?? 'professional');
        setSaiSystemPrompt(saiConfig.systemPrompt ?? '');
      }
      setSaiConfigLoaded(true);
    }
  }, [saiConfig, saiConfigLoaded]);

  const saiSaveMutation = useMutation({
    mutationFn: (body: {
      provider: string;
      apiKey: string;
      model?: string;
      temperature?: number;
      topP?: number;
      topK?: number;
      tone?: string;
      systemPrompt?: string;
    }) => api.put('/v1/users/me/support-ai-config', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['support-ai-config'] });
      setSaiApiKey('');
    },
  });

  const saiRemoveMutation = useMutation({
    mutationFn: () => api.delete('/v1/users/me/support-ai-config'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['support-ai-config'] });
      setSaiProvider('anthropic');
      setSaiApiKey('');
      setSaiModelOverride('');
      setSaiTemperature('');
      setSaiTopP('');
      setSaiTopK('');
      setSaiTone('professional');
      setSaiSystemPrompt('');
      setSaiConfigLoaded(false);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.supportAi')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('profile.supportAiDescription')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="sai-profile-provider">{t('profile.supportAiProvider')}</Label>
          <select
            id="sai-profile-provider"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={saiProvider}
            onChange={(e) => {
              setSaiProvider(e.target.value);
            }}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="sai-profile-api-key">{t('profile.supportAiApiKey')}</Label>
          <PasswordInput
            id="sai-profile-api-key"
            value={saiApiKey}
            onChange={(e) => {
              setSaiApiKey(e.target.value);
            }}
            placeholder={saiConfig?.configured ? t('profile.supportAiApiKeyConfigured') : ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sai-profile-model">{t('profile.supportAiModel')}</Label>
          <Input
            id="sai-profile-model"
            value={saiModelOverride}
            onChange={(e) => {
              setSaiModelOverride(e.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">{t('profile.supportAiModelHelp')}</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="sai-profile-temperature">{t('profile.supportAiTemperature')}</Label>
            <Input
              id="sai-profile-temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={saiTemperature}
              onChange={(e) => {
                setSaiTemperature(e.target.value);
              }}
              placeholder="0.3"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sai-profile-top-p">{t('profile.supportAiTopP')}</Label>
            <Input
              id="sai-profile-top-p"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={saiTopP}
              onChange={(e) => {
                setSaiTopP(e.target.value);
              }}
              placeholder="0.9"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sai-profile-top-k">{t('profile.supportAiTopK')}</Label>
            <Input
              id="sai-profile-top-k"
              type="number"
              min={1}
              max={100}
              step={1}
              value={saiTopK}
              onChange={(e) => {
                setSaiTopK(e.target.value);
              }}
              placeholder="40"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="sai-profile-tone">{t('profile.supportAiTone')}</Label>
          <select
            id="sai-profile-tone"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={saiTone}
            onChange={(e) => {
              setSaiTone(e.target.value);
            }}
          >
            <option value="professional">Professional</option>
            <option value="friendly">Friendly</option>
            <option value="formal">Formal</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="sai-profile-system-prompt">{t('profile.supportAiSystemPrompt')}</Label>
          <textarea
            id="sai-profile-system-prompt"
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={saiSystemPrompt}
            onChange={(e) => {
              setSaiSystemPrompt(e.target.value);
            }}
            placeholder="You are a helpful support agent for an EV charging network. Draft professional replies to driver support cases. Be empathetic, concise, and solution-oriented."
          />
        </div>
        <div className="flex gap-2">
          <SaveButton
            isPending={saiSaveMutation.isPending}
            onClick={() => {
              if (saiApiKey === '' && !saiConfig?.configured) return;
              saiSaveMutation.mutate({
                provider: saiProvider,
                apiKey: saiApiKey,
                ...(saiModelOverride !== '' ? { model: saiModelOverride } : {}),
                ...(saiTemperature !== '' ? { temperature: Number(saiTemperature) } : {}),
                ...(saiTopP !== '' ? { topP: Number(saiTopP) } : {}),
                ...(saiTopK !== '' ? { topK: Number(saiTopK) } : {}),
                ...(saiTone !== '' ? { tone: saiTone } : {}),
                ...(saiSystemPrompt !== '' ? { systemPrompt: saiSystemPrompt } : {}),
              });
            }}
          />
          {saiConfig?.configured && (
            <Button
              variant="destructive"
              onClick={() => {
                setSaiRemoveOpen(true);
              }}
            >
              {t('profile.supportAiRemoveConfig')}
            </Button>
          )}
        </div>
        <ConfirmDialog
          open={saiRemoveOpen}
          onOpenChange={setSaiRemoveOpen}
          title={t('profile.supportAiRemoveConfig')}
          description={t('profile.supportAiRemoveConfirm')}
          confirmLabel={t('common.delete')}
          variant="destructive"
          isPending={saiRemoveMutation.isPending}
          onConfirm={() => {
            saiRemoveMutation.mutate();
          }}
        />
      </CardContent>
    </Card>
  );
}
