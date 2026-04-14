// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { api } from '@/lib/api';

interface NotificationPreferences {
  smsEnabled: boolean;
}

export function ProfileNotifications(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: prefs } = useQuery({
    queryKey: ['user-notification-preferences'],
    queryFn: () => api.get<NotificationPreferences>('/v1/users/me/notification-preferences'),
  });

  const updateMutation = useMutation({
    mutationFn: (body: { smsEnabled: boolean }) =>
      api.put('/v1/users/me/notification-preferences', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['user-notification-preferences'] });
    },
  });

  const smsEnabled = prefs?.smsEnabled ?? true;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.notifications')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('profile.notificationsDescription')}</p>
        <div className="flex items-center justify-between">
          <Label htmlFor="sms-toggle">{t('profile.receiveSms')}</Label>
          <Toggle
            id="sms-toggle"
            checked={smsEnabled}
            onCheckedChange={(checked) => {
              updateMutation.mutate({ smsEnabled: checked });
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
