// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTab } from '@/hooks/use-tab';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WysiwygEditor } from '@/components/wysiwyg-editor';
import { api } from '@/lib/api';

export function ContentSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [contentLang, setContentLang] = useState<'en' | 'es' | 'zh'>('en');
  const [privacyContent, setPrivacyContent] = useState('');
  const [termsContent, setTermsContent] = useState('');
  const [contentSubTab, setContentSubTab] = useTab('privacy', 'sub');

  const { data: privacyData } = useQuery({
    queryKey: ['settings', 'content.privacyPolicy', contentLang],
    queryFn: () =>
      api.get<{ html: string }>(`/v1/portal/content/privacy-policy?lang=${contentLang}`),
  });
  const { data: termsData } = useQuery({
    queryKey: ['settings', 'content.termsOfService', contentLang],
    queryFn: () =>
      api.get<{ html: string }>(`/v1/portal/content/terms-of-service?lang=${contentLang}`),
  });

  useEffect(() => {
    setPrivacyContent(privacyData?.html ?? '');
  }, [privacyData]);
  useEffect(() => {
    setTermsContent(termsData?.html ?? '');
  }, [termsData]);

  const privacyMutation = useMutation({
    mutationFn: (html: string) =>
      api.put(`/v1/settings/content.privacyPolicy.${contentLang}`, { value: html }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['settings', 'content.privacyPolicy', contentLang],
      });
    },
  });
  const termsMutation = useMutation({
    mutationFn: (html: string) =>
      api.put(`/v1/settings/content.termsOfService.${contentLang}`, { value: html }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['settings', 'content.termsOfService', contentLang],
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.content')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[180px_1fr] gap-6">
          <div className="space-y-1">
            <Label className="mb-2 block text-xs text-muted-foreground">
              {t('settings.language')}
            </Label>
            {(['en', 'es', 'zh'] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => {
                  setContentLang(lang);
                }}
                className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  contentLang === lang
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground hover:bg-muted'
                }`}
              >
                {lang === 'en' ? 'English' : lang === 'es' ? 'Espa\u00f1ol' : '\u4e2d\u6587'}
              </button>
            ))}
          </div>

          <div className="space-y-4">
            <Tabs value={contentSubTab} onValueChange={setContentSubTab}>
              <TabsList>
                <TabsTrigger value="privacy">{t('settings.privacyPolicy')}</TabsTrigger>
                <TabsTrigger value="terms">{t('settings.termsOfService')}</TabsTrigger>
              </TabsList>
              <TabsContent value="privacy" className="mt-4 space-y-4">
                <WysiwygEditor value={privacyContent} onChange={setPrivacyContent} />
                <SaveButton
                  isPending={privacyMutation.isPending}
                  type="button"
                  onClick={() => {
                    privacyMutation.mutate(privacyContent);
                  }}
                />
                {privacyMutation.isSuccess && (
                  <p className="text-sm text-green-600">{t('settings.contentSaved')}</p>
                )}
                {privacyMutation.isError && (
                  <p className="text-sm text-destructive">{t('settings.contentSaveFailed')}</p>
                )}
              </TabsContent>
              <TabsContent value="terms" className="mt-4 space-y-4">
                <WysiwygEditor value={termsContent} onChange={setTermsContent} />
                <SaveButton
                  isPending={termsMutation.isPending}
                  type="button"
                  onClick={() => {
                    termsMutation.mutate(termsContent);
                  }}
                />
                {termsMutation.isSuccess && (
                  <p className="text-sm text-green-600">{t('settings.contentSaved')}</p>
                )}
                {termsMutation.isError && (
                  <p className="text-sm text-destructive">{t('settings.contentSaveFailed')}</p>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
