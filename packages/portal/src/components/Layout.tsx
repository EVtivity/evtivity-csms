// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Home, Activity, PlugZap, User, Bell, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useAuthBranding } from './AuthBranding';
import { NotificationDrawer } from './NotificationDrawer';
import { usePortalEvents } from '@/hooks/use-portal-events';

const navItems = [
  { to: '/', labelKey: 'nav.home', icon: Home },
  { to: '/start', labelKey: 'nav.findCharger', icon: PlugZap },
  { to: '/activity', labelKey: 'nav.activity', icon: Activity },
  { to: '/account', labelKey: 'nav.account', icon: User },
];

export function Layout(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { companyName, companyLogo } = useAuthBranding();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  usePortalEvents();

  useEffect(() => {
    const handleOnline = (): void => {
      setIsOffline(false);
    };
    const handleOffline = (): void => {
      setIsOffline(true);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const { data: unreadData } = useQuery({
    queryKey: ['portal-notifications-unread'],
    queryFn: () => api.get<{ count: number }>('/v1/portal/notifications/unread-count'),
    refetchInterval: 60000,
  });
  const unreadCount = unreadData?.count ?? 0;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-4 py-3">
        <button
          onClick={() => {
            void navigate('/');
          }}
          className="flex items-center gap-2"
        >
          <img
            src={companyLogo ?? '/evtivity-logo.svg'}
            alt={companyName ?? 'EVtivity'}
            className="h-6 w-6 object-contain"
          />
          <span className="font-bold">{companyName ?? 'EVtivity'}</span>
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              void navigate('/favorites');
            }}
            className="relative h-10 w-10 flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t('favorites.title')}
          >
            <Star className="h-5 w-5" />
          </button>
          <button
            onClick={() => {
              setDrawerOpen(true);
            }}
            className="relative h-10 w-10 flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t('notifications.title')}
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-destructive-foreground">
                {unreadCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Offline banner */}
      {isOffline && (
        <div className="bg-warning text-warning-foreground px-4 py-2 text-center text-sm font-medium">
          {t('common.offline')}
        </div>
      )}

      {/* Main content */}
      <main className="flex flex-1 flex-col overflow-auto px-4 py-4 pb-20">
        <Outlet />
      </main>

      {/* Bottom tab navigation */}
      <nav className="fixed bottom-0 left-0 right-0 h-16 z-30 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
        <div className="flex">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex flex-1 flex-col items-center gap-1 py-2 text-xs font-medium transition-colors',
                  isActive ? 'text-primary' : 'text-muted-foreground',
                )
              }
            >
              <item.icon className="h-5 w-5" />
              {t(item.labelKey)}
            </NavLink>
          ))}
        </div>
      </nav>

      <NotificationDrawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
        }}
      />
    </div>
  );
}
