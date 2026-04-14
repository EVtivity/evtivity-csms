// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import Handlebars from 'handlebars';
import { useTab } from '@/hooks/use-tab';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';

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

const SAMPLE_EMAIL_BODY = `<p style="color:#4b5563;line-height:1.6;margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">Hi John,</p>
<p style="color:#4b5563;line-height:1.6;margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">Your charging session at <strong>Main Street Charger</strong> has been completed.</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;border-spacing:0;margin-bottom:24px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
  <tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;font-weight:600;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;text-align:left;vertical-align:top;">Energy</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;text-align:left;vertical-align:top;">15.0 kWh</td></tr>
  <tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;font-weight:600;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;text-align:left;vertical-align:top;">Duration</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;text-align:left;vertical-align:top;">45 minutes</td></tr>
  <tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;font-weight:600;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;text-align:left;vertical-align:top;">Cost</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;text-align:left;vertical-align:top;">$12.50</td></tr>
</table>
<p style="color:#4b5563;line-height:1.6;margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">Thank you for charging with us.</p>`;

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
    setSmtpPassword(s('smtp.password'));
    setSmtpFrom(s('smtp.from'));
    setTwilioAccountSid(s('twilio.accountSid'));
    setTwilioAuthToken(s('twilio.authToken'));
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
        api.put('/v1/settings/smtp.password', { value: vals.password }),
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
        api.put('/v1/settings/twilio.authToken', { value: vals.authToken }),
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

  const previewHtml = useMemo(() => {
    try {
      const sv = (key: string): string => {
        if (settings == null) return '';
        const v = settings[key];
        return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
      };
      const compiled = Handlebars.compile(emailWrapperTemplate);
      return compiled({
        content: SAMPLE_EMAIL_BODY,
        companyName: sv('company.name') || 'EVtivity',
        companyCurrency: sv('company.currency') || 'USD',
        companyContactEmail: sv('company.contactEmail'),
        companySupportEmail: sv('company.supportEmail'),
        companySupportPhone: sv('company.supportPhone'),
        companyStreet: sv('company.street'),
        companyCity: sv('company.city'),
        companyState: sv('company.state'),
        companyZip: sv('company.zip'),
        companyCountry: sv('company.country'),
      });
    } catch {
      return emailWrapperTemplate;
    }
  }, [emailWrapperTemplate, settings]);

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
                <Label htmlFor="smtp-host">{t('settings.smtpHost')}</Label>
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
                <Label htmlFor="smtp-port">{t('settings.smtpPort')}</Label>
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
                <Label htmlFor="smtp-username">{t('settings.smtpUsername')}</Label>
                <Input
                  id="smtp-username"
                  value={smtpUsername}
                  onChange={(e) => {
                    setSmtpUsername(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="smtp-password">{t('settings.smtpPassword')}</Label>
                <PasswordInput
                  id="smtp-password"
                  value={smtpPassword}
                  onChange={(e) => {
                    setSmtpPassword(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="smtp-from">{t('settings.smtpFrom')}</Label>
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

            <div className="flex gap-2">
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
              <Button
                variant="outline"
                onClick={() => {
                  testNotificationMutation.mutate({ channel: 'email', recipient: smtpFrom });
                }}
                disabled={testNotificationMutation.isPending || smtpHost === ''}
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
                <Label htmlFor="twilio-sid">{t('settings.twilioAccountSid')}</Label>
                <Input
                  id="twilio-sid"
                  value={twilioAccountSid}
                  onChange={(e) => {
                    setTwilioAccountSid(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="twilio-token">{t('settings.twilioAuthToken')}</Label>
                <PasswordInput
                  id="twilio-token"
                  value={twilioAuthToken}
                  onChange={(e) => {
                    setTwilioAuthToken(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="twilio-from">{t('settings.twilioFromNumber')}</Label>
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

            <div className="flex gap-2">
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
              <Button
                variant="outline"
                onClick={() => {
                  testNotificationMutation.mutate({
                    channel: 'sms',
                    recipient: twilioFromNumber,
                  });
                }}
                disabled={testNotificationMutation.isPending || twilioAccountSid === ''}
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
                <Label htmlFor="email-wrapper-template">HTML Template</Label>
                <textarea
                  id="email-wrapper-template"
                  className="h-[500px] w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
                  value={emailWrapperTemplate}
                  onChange={(e) => {
                    setEmailWrapperTemplate(e.target.value);
                  }}
                  spellCheck={false}
                />
                <div className="flex gap-2">
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
                <Label>{t('settings.emailLayoutPreview')}</Label>
                <div className="overflow-hidden rounded-md border">
                  <iframe
                    title="Email layout preview"
                    srcDoc={previewHtml}
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
