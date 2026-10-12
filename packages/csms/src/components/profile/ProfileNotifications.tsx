// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';

interface NotificationPreferences {
  smsEnabled: boolean;
  /** Daily AI insight action digest opt-in (roadmap v0.1.44, default off). */
  aiDigestEmail: boolean;
}

export function ProfileNotifications(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: prefs } = useQuery({
    queryKey: ['user-notification-preferences'],
    queryFn: () => api.get<NotificationPreferences>('/v1/users/me/notification-preferences'),
  });

  const canDecideActions = useHasPermission('aiInsights:write');

  const updateMutation = useMutation({
    // Either field alone: the API keeps the other one.
    mutationFn: (body: Partial<NotificationPreferences>) =>
      api.put<NotificationPreferences>('/v1/users/me/notification-preferences', body),
    onSuccess: (saved) => {
      queryClient.setQueryData(['user-notification-preferences'], saved);
    },
  });

  // The switch shows the new value while it saves and the stored one after a
  // failure (the error shows inline).
  const saving = updateMutation.isPending ? updateMutation.variables : undefined;
  const smsEnabled = saving?.smsEnabled ?? prefs?.smsEnabled ?? true;
  // The digest goes only to users who can decide insight actions.
  const aiDigest = saving?.aiDigestEmail ?? prefs?.aiDigestEmail ?? false;
  const save = (change: Partial<NotificationPreferences>): void => {
    updateMutation.mutate(change);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.notifications')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('profile.notificationsDescription')}</p>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="sms-toggle" className="whitespace-nowrap">
            {t('profile.receiveSms')}
          </Label>
          <Toggle
            id="sms-toggle"
            checked={smsEnabled}
            onCheckedChange={(checked) => {
              save({ smsEnabled: checked });
            }}
          />
        </div>
        {canDecideActions && prefs != null && (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="ai-digest-toggle">{t('profile.aiDigestEmail')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('profile.aiDigestEmailDescription')}
              </p>
            </div>
            <Toggle
              id="ai-digest-toggle"
              checked={aiDigest}
              disabled={updateMutation.isPending}
              onCheckedChange={(checked) => {
                save({ aiDigestEmail: checked });
              }}
            />
          </div>
        )}
        {updateMutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('profile.notificationsSaveFailed')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
