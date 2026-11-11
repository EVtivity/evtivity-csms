// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isUiLanguage, type UiLanguage } from '@evtivity/lib/languages';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTab } from '@/hooks/use-tab';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WysiwygEditor } from '@/components/wysiwyg-editor';
import { LanguageSelect, LANGUAGES } from '@/components/ui/language-select';
import { Button } from '@/components/ui/button';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { api } from '@/lib/api';

type ContentDocument = 'privacyPolicy' | 'termsOfService';

const CONTENT_PATHS: Record<ContentDocument, string> = {
  privacyPolicy: 'privacy-policy',
  termsOfService: 'terms-of-service',
};

/**
 * The editor of one document in one language. Keyed by the language, so a
 * language switch starts from that language's stored text, while a reload of
 * the same document (window focus, another card's save) replaces the text
 * only while it is unedited.
 */
function ContentDocumentEditor({
  doc,
  lang,
}: {
  doc: ContentDocument;
  lang: UiLanguage;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ['settings', `content.${doc}`, lang];

  const { data } = useQuery({
    queryKey,
    queryFn: () =>
      api.get<{ html: string }>(`/v1/portal/content/${CONTENT_PATHS[doc]}?lang=${lang}`),
  });
  const loaded = useMemo(() => ({ html: data?.html ?? '' }), [data]);
  const [values, setValues, takeNextLoad] = useLoadedValues(loaded);

  const mutation = useMutation({
    mutationFn: (html: string) => api.put(`/v1/settings/content.${doc}.${lang}`, { value: html }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <>
      <WysiwygEditor
        value={values.html}
        onChange={(html) => {
          setValues({ html });
        }}
      />
      <SaveButton
        isPending={mutation.isPending}
        type="button"
        onClick={() => {
          const sent = values;
          mutation.mutate(sent.html, {
            onSuccess: () => {
              takeNextLoad(sent);
            },
          });
        }}
      />
      {mutation.isSuccess && <p className="text-sm text-success">{t('settings.contentSaved')}</p>}
      {mutation.isError && (
        <p className="text-sm text-destructive">{t('settings.contentSaveFailed')}</p>
      )}
    </>
  );
}

export function ContentSettings(): React.JSX.Element {
  const { t } = useTranslation();

  const [contentLang, setContentLang] = useState<UiLanguage>('en');
  const [contentSubTab, setContentSubTab] = useTab('privacy', 'sub');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.content')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[180px_1fr]">
          <div className="space-y-1">
            <Label htmlFor="content-language" className="mb-2 block text-xs text-muted-foreground">
              {t('settings.language')}
            </Label>
            <LanguageSelect
              id="content-language"
              className="md:hidden"
              value={contentLang}
              onChange={(value) => {
                if (isUiLanguage(value)) setContentLang(value);
              }}
            />
            <div className="hidden space-y-1 md:block">
              {LANGUAGES.map(({ code: lang, label }) => (
                <Button
                  key={lang}
                  type="button"
                  variant={contentLang === lang ? 'default' : 'ghost'}
                  size="row"
                  aria-pressed={contentLang === lang}
                  onClick={() => {
                    setContentLang(lang);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>

          <div className="min-w-0 space-y-4">
            <Tabs value={contentSubTab} onValueChange={setContentSubTab}>
              <TabsList>
                <TabsTrigger value="privacy">{t('settings.privacyPolicy')}</TabsTrigger>
                <TabsTrigger value="terms">{t('settings.termsOfService')}</TabsTrigger>
              </TabsList>
              <TabsContent value="privacy" className="mt-4 space-y-4">
                <ContentDocumentEditor key={contentLang} doc="privacyPolicy" lang={contentLang} />
              </TabsContent>
              <TabsContent value="terms" className="mt-4 space-y-4">
                <ContentDocumentEditor key={contentLang} doc="termsOfService" lang={contentLang} />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
