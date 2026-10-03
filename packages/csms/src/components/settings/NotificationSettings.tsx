// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useTab } from '@/hooks/use-tab';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, getApiErrorFieldDetails } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

const DEFAULT_EMAIL_WRAPPER = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!--[if mso]>
<style type="text/css">
  table { border-collapse: collapse; border-spacing: 0; margin: 0; }
  td, th { font-family: Arial, sans-serif; }
</style>
<![endif]-->
</head>
<body style="margin:0;padding:16px;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1a1a1a;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border-spacing:0;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <tr>
      <td align="center" style="padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;border-collapse:collapse;border-spacing:0;background-color:#ffffff;border-radius:8px;overflow:hidden;mso-table-lspace:0pt;mso-table-rspace:0pt;">
          <tr>
            <td align="center" style="background-color:#2563eb;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">{{companyName}}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 24px;color:#1a1a1a;font-size:16px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              {{{content}}}
            </td>
          </tr>
          <tr>
            <td align="center" style="background-color:#f9fafb;padding:16px 24px;border-top:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              <p style="color:#9ca3af;font-size:12px;margin:0 0 4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">{{companyName}}</p>
              <p style="color:#9ca3af;font-size:11px;margin:0 0 4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">{{companyStreet}}{{#if companyCity}}, {{companyCity}}{{/if}}{{#if companyState}}, {{companyState}}{{/if}} {{companyZip}}{{#if companyCountry}}, {{companyCountry}}{{/if}}</p>
              <p style="color:#9ca3af;font-size:11px;margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">{{#if companyContactEmail}}{{companyContactEmail}}{{/if}}{{#if companySupportPhone}} | {{companySupportPhone}}{{/if}}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

interface NotificationSettingsProps {
  settings: Record<string, unknown> | undefined;
}

export function NotificationSettings({ settings }: NotificationSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');

  const [twilioAccountSid, setTwilioAccountSid] = useState('');
  const [twilioAuthToken, setTwilioAuthToken] = useState('');
  const [twilioFromNumber, setTwilioFromNumber] = useState('');

  const [testEmailRecipient, setTestEmailRecipient] = useState('');
  const [testSmsRecipient, setTestSmsRecipient] = useState('');

  const [emailWrapperTemplate, setEmailWrapperTemplate] = useState(DEFAULT_EMAIL_WRAPPER);
  const [notificationSubTab, setNotificationSubTab] = useTab('smtp', 'sub');
  const [copiedVar, setCopiedVar] = useState<string | null>(null);

  useEffect(() => {
    if (settings == null) return;
    const s = (key: string): string => {
      const v = settings[key];
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    };
    setSmtpHost(s('smtp.host'));
    setSmtpPort(s('smtp.port') || '587');
    setSmtpUsername(s('smtp.username'));
    setSmtpPassword(s('smtp.passwordEnc'));
    const fromAddr = s('smtp.from');
    setSmtpFrom(fromAddr);
    setTestEmailRecipient((current) => (current === '' ? fromAddr : current));
    setTwilioAccountSid(s('twilio.accountSid'));
    setTwilioAuthToken(s('twilio.authTokenEnc'));
    setTwilioFromNumber(s('twilio.fromNumber'));
    const wrapper = s('email.wrapperTemplate');
    setEmailWrapperTemplate(wrapper !== '' ? wrapper : DEFAULT_EMAIL_WRAPPER);
  }, [settings]);

  const smtpMutation = useMutation({
    mutationFn: (vals: {
      host: string;
      port: string;
      username: string;
      password: string;
      from: string;
    }) =>
      Promise.all([
        api.put('/v1/settings/smtp.host', { value: vals.host }),
        api.put('/v1/settings/smtp.port', { value: Number(vals.port) }),
        api.put('/v1/settings/smtp.username', { value: vals.username }),
        api.put('/v1/settings/smtp.passwordEnc', { value: vals.password }),
        api.put('/v1/settings/smtp.from', { value: vals.from }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const twilioMutation = useMutation({
    mutationFn: (vals: { accountSid: string; authToken: string; fromNumber: string }) =>
      Promise.all([
        api.put('/v1/settings/twilio.accountSid', { value: vals.accountSid }),
        api.put('/v1/settings/twilio.authTokenEnc', { value: vals.authToken }),
        api.put('/v1/settings/twilio.fromNumber', { value: vals.fromNumber }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const testNotificationMutation = useMutation({
    mutationFn: (body: { channel: 'email' | 'sms'; recipient: string }) =>
      api.post<{ success: boolean }>('/v1/notifications/test', body),
  });

  const emailLayoutMutation = useMutation({
    mutationFn: (value: string) => api.put('/v1/settings/email.wrapperTemplate', { value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const emailLayoutResetMutation = useMutation({
    mutationFn: () => api.delete('/v1/settings/email.wrapperTemplate'),
    onSuccess: () => {
      setEmailWrapperTemplate(DEFAULT_EMAIL_WRAPPER);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  // Rendered on the server: the dashboard Content Security Policy blocks Handlebars here.
  const debouncedWrapperTemplate = useDebouncedValue(emailWrapperTemplate, 400);
  const preview = useQuery({
    queryKey: ['email-wrapper-preview', debouncedWrapperTemplate],
    queryFn: () =>
      api.post<{ html: string }>('/v1/email-wrapper/preview', {
        wrapperTemplate: debouncedWrapperTemplate,
      }),
    enabled: notificationSubTab === 'emailLayout',
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
  const previewError = preview.isError
    ? (getApiErrorFieldDetails(preview.error)['wrapperTemplate'] ??
      getErrorMessage(preview.error, t))
    : null;

  return (
    <Tabs value={notificationSubTab} onValueChange={setNotificationSubTab}>
      <TabsList>
        <TabsTrigger value="smtp">{t('settings.smtp')}</TabsTrigger>
        <TabsTrigger value="twilio">{t('settings.twilio')}</TabsTrigger>
        <TabsTrigger value="emailLayout">{t('settings.emailLayout')}</TabsTrigger>
      </TabsList>
      <TabsContent value="smtp" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.smtp')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.smtpDescription')}</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="smtp-host" className="leading-6">
                  {t('settings.smtpHost')}
                </Label>
                <Input
                  id="smtp-host"
                  value={smtpHost}
                  onChange={(e) => {
                    setSmtpHost(e.target.value);
                  }}
                  placeholder="smtp.example.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="smtp-port" className="leading-6">
                  {t('settings.smtpPort')}
                </Label>
                <Input
                  id="smtp-port"
                  type="number"
                  value={smtpPort}
                  onChange={(e) => {
                    setSmtpPort(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="smtp-username" className="leading-6">
                  {t('settings.smtpUsername')}
                </Label>
                <Input
                  id="smtp-username"
                  value={smtpUsername}
                  onChange={(e) => {
                    setSmtpUsername(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="smtp-password" className="leading-6">
                  {t('settings.smtpPassword')}
                </Label>
                <PasswordInput
                  id="smtp-password"
                  value={smtpPassword}
                  onChange={(e) => {
                    setSmtpPassword(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="smtp-from" className="leading-6">
                  {t('settings.smtpFrom')}
                </Label>
                <Input
                  id="smtp-from"
                  value={smtpFrom}
                  onChange={(e) => {
                    setSmtpFrom(e.target.value);
                  }}
                  placeholder="noreply@example.com"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <SaveButton
                isPending={smtpMutation.isPending}
                type="button"
                onClick={() => {
                  smtpMutation.mutate({
                    host: smtpHost,
                    port: smtpPort,
                    username: smtpUsername,
                    password: smtpPassword,
                    from: smtpFrom,
                  });
                }}
              />
              <Input
                aria-label={t('settings.testRecipientLabel')}
                value={testEmailRecipient}
                onChange={(e) => {
                  setTestEmailRecipient(e.target.value);
                }}
                placeholder="test@example.com"
                className="w-64"
              />
              <Button
                variant="outline"
                onClick={() => {
                  testNotificationMutation.mutate({
                    channel: 'email',
                    recipient: testEmailRecipient,
                  });
                }}
                disabled={
                  testNotificationMutation.isPending ||
                  smtpHost === '' ||
                  testEmailRecipient.trim() === ''
                }
              >
                <Send className="h-4 w-4" />
                {t('settings.testNotification')}
              </Button>
            </div>
            {smtpMutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.smtpSaved')}</p>
            )}
            {smtpMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.smtpSaveFailed')}</p>
            )}
            {testNotificationMutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.testSuccess')}</p>
            )}
            {testNotificationMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.testFailed')}</p>
            )}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="twilio" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.twilio')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.twilioDescription')}</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="twilio-sid" className="leading-6">
                  {t('settings.twilioAccountSid')}
                </Label>
                <Input
                  id="twilio-sid"
                  value={twilioAccountSid}
                  onChange={(e) => {
                    setTwilioAccountSid(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="twilio-token" className="leading-6">
                  {t('settings.twilioAuthToken')}
                </Label>
                <PasswordInput
                  id="twilio-token"
                  value={twilioAuthToken}
                  onChange={(e) => {
                    setTwilioAuthToken(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="twilio-from" className="leading-6">
                  {t('settings.twilioFromNumber')}
                </Label>
                <Input
                  id="twilio-from"
                  value={twilioFromNumber}
                  onChange={(e) => {
                    setTwilioFromNumber(e.target.value);
                  }}
                  placeholder="+15551234567"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <SaveButton
                isPending={twilioMutation.isPending}
                type="button"
                onClick={() => {
                  twilioMutation.mutate({
                    accountSid: twilioAccountSid,
                    authToken: twilioAuthToken,
                    fromNumber: twilioFromNumber,
                  });
                }}
              />
              <Input
                aria-label={t('settings.testRecipientLabel')}
                value={testSmsRecipient}
                onChange={(e) => {
                  setTestSmsRecipient(e.target.value);
                }}
                placeholder="+15551234567"
                className="w-64"
              />
              <Button
                variant="outline"
                onClick={() => {
                  testNotificationMutation.mutate({
                    channel: 'sms',
                    recipient: testSmsRecipient,
                  });
                }}
                disabled={
                  testNotificationMutation.isPending ||
                  twilioAccountSid === '' ||
                  testSmsRecipient.trim() === ''
                }
              >
                <Send className="h-4 w-4" />
                {t('settings.testNotification')}
              </Button>
            </div>
            {twilioMutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.twilioSaved')}</p>
            )}
            {twilioMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.twilioSaveFailed')}</p>
            )}
            {testNotificationMutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.testSuccess')}</p>
            )}
            {testNotificationMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.testFailed')}</p>
            )}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="emailLayout" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.emailLayout')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.emailLayoutDescription')}</p>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t('settings.emailLayoutVariables')}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  'companyName',
                  'companyContactEmail',
                  'companySupportEmail',
                  'companySupportPhone',
                  'companyStreet',
                  'companyCity',
                  'companyState',
                  'companyZip',
                  'companyCountry',
                  'companyCurrency',
                ].map((v) => (
                  <span key={v} className="relative">
                    <button
                      type="button"
                      className="cursor-pointer rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/70 active:bg-primary/10"
                      onClick={() => {
                        void navigator.clipboard.writeText(`{{${v}}}`);
                        setCopiedVar(v);
                        setTimeout(() => {
                          setCopiedVar((cur) => (cur === v ? null : cur));
                        }, 1500);
                      }}
                    >
                      {`{{${v}}}`}
                    </button>
                    {copiedVar === v && (
                      <span className="absolute -top-7 left-1/2 -translate-x-1/2 rounded bg-foreground px-1.5 py-0.5 text-xs text-background">
                        Copied
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                <Label htmlFor="email-wrapper-template" className="leading-6">
                  HTML Template
                </Label>
                <textarea
                  id="email-wrapper-template"
                  className="h-[500px] w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
                  value={emailWrapperTemplate}
                  onChange={(e) => {
                    setEmailWrapperTemplate(e.target.value);
                  }}
                  spellCheck={false}
                />
                <div className="flex justify-end gap-2">
                  <SaveButton
                    isPending={emailLayoutMutation.isPending}
                    type="button"
                    onClick={() => {
                      emailLayoutMutation.mutate(emailWrapperTemplate);
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => {
                      emailLayoutResetMutation.mutate();
                    }}
                    disabled={emailLayoutResetMutation.isPending}
                  >
                    {t('settings.emailLayoutResetToDefault')}
                  </Button>
                </div>
                {emailLayoutMutation.isSuccess && (
                  <p className="text-sm text-green-600">{t('settings.emailLayoutSaved')}</p>
                )}
                {emailLayoutMutation.isError && (
                  <p className="text-sm text-destructive">{t('settings.emailLayoutSaveFailed')}</p>
                )}
                {emailLayoutResetMutation.isSuccess && (
                  <p className="text-sm text-green-600">{t('settings.emailLayoutReset')}</p>
                )}
              </div>

              <div className="space-y-3">
                <Label className="leading-6">{t('settings.emailLayoutPreview')}</Label>
                {previewError != null && (
                  <p className="text-sm text-destructive">
                    {t('settings.emailLayoutInvalid')} {previewError}
                  </p>
                )}
                <div className="overflow-hidden rounded-md border">
                  <iframe
                    title="Email layout preview"
                    srcDoc={preview.data?.html ?? ''}
                    className="h-[500px] w-full"
                    sandbox=""
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
