// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { api } from '@/lib/api';

interface Notification {
  id: number;
  channel: string;
  subject: string | null;
  eventType: string | null;
  createdAt: string;
}

interface NotificationsResponse {
  data: Notification[];
  total: number;
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

interface NotificationDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationDrawer({
  open,
  onClose,
}: NotificationDrawerProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['portal-notifications'],
    queryFn: () => api.get<NotificationsResponse>('/v1/portal/notifications?limit=50'),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    void api.post('/v1/portal/notifications/mark-read', {}).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['portal-notifications-unread'] });
    });
  }, [open, queryClient]);

  if (!open) return null;

  const notifications = data?.data ?? [];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} role="presentation" />
      <div className="fixed bottom-0 left-0 right-0 z-50 max-h-[80dvh] overflow-y-auto rounded-t-lg bg-background pb-[env(safe-area-inset-bottom,0px)]">
        <div className="sticky top-0 flex items-center justify-between border-b bg-background p-4">
          <h2 className="text-lg font-semibold">{t('notifications.title')}</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4">
          {notifications.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('notifications.noNotifications')}
            </p>
          )}
          <div className="space-y-3">
            {notifications.map((n) => (
              <div key={n.id} className="border-b pb-3 last:border-b-0">
                <p className="text-sm">{n.subject ?? '--'}</p>
                <p className="text-xs text-muted-foreground">{relativeTime(n.createdAt)}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
