// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Menu, X, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { AiAssistant } from '@/components/AiAssistant';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { UserDropdown } from '@/components/layout/UserDropdown';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useEventStream } from '@/hooks/use-event-stream';
import { api } from '@/lib/api';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { visibleNavEntries, type NavEntry } from '@/navigation/registry';

function SidebarContent({
  onNavClick,
  companyName,
  companyLogo,
  collapsed = false,
  onToggleCollapse,
  visibleNavItems,
}: {
  onNavClick?: () => void;
  companyName: string;
  companyLogo: string | null;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  visibleNavItems: readonly NavEntry[];
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <>
      <div className={cn('p-6', collapsed && 'flex flex-col items-center px-2 py-4')}>
        <div className={cn('flex items-center gap-2', collapsed && 'justify-center')}>
          <Link to="/" className="flex items-center gap-2">
            <img
              src={companyLogo ?? '/evtivity-logo-animated.svg'}
              alt={companyName}
              className="h-8 w-8 shrink-0 object-contain"
            />
            {!collapsed && <span className="text-xl font-bold">{companyName}</span>}
          </Link>
          {!collapsed && onToggleCollapse != null && (
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-7 w-7 shrink-0"
              onClick={onToggleCollapse}
              aria-label={t('nav.collapseSidebar')}
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
          )}
        </div>
        {!collapsed && (
          <p className="mt-1 pl-8 text-xs text-muted-foreground">{t('nav.poweredBy')}</p>
        )}
        {collapsed && onToggleCollapse != null && (
          <Button
            variant="ghost"
            size="icon"
            className="mt-2 mx-auto h-7 w-7"
            onClick={onToggleCollapse}
            aria-label={t('nav.expandSidebar')}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        )}
      </div>
      <Separator />
      <SidebarNav items={visibleNavItems} collapsed={collapsed} onNavClick={onNavClick} />
      <Separator />
      <UserDropdown collapsed={collapsed} onNavClick={onNavClick} />
    </>
  );
}

const SIDEBAR_COLLAPSED_KEY = 'sidebar-collapsed';

export function Layout(): React.JSX.Element {
  const { t } = useTranslation();
  useEventStream();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  });
  const location = useLocation();

  const toggleCollapsed = (): void => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  // Public endpoints: users without settings permissions see the branding and
  // the feature toggles too. The features key sits under ['settings'] so saving
  // a toggle refreshes the nav.
  const { data: branding } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
  });
  const { flags: featureFlags } = useFeatureFlags();
  const brandingValue = (key: string): string | null => {
    const value = branding?.[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const companyName = brandingValue('name') ?? 'EVtivity';
  const companyLogo = brandingValue('logo');
  const favicon = brandingValue('favicon') ?? '';

  useEffect(() => {
    document.title = `${companyName} CSMS`;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon === '') {
      link?.remove();
    } else {
      if (link == null) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = favicon;
    }
  }, [companyName, favicon]);

  const permissions = useAuth((s) => s.permissions);
  const visibleNavItems = visibleNavEntries(permissions, featureFlags);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'hidden lg:flex flex-col border-r bg-card transition-all duration-200',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <SidebarContent
          companyName={companyName}
          companyLogo={companyLogo}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapsed}
          visibleNavItems={visibleNavItems}
        />
      </aside>

      {/* Mobile backdrop */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-xs lg:hidden"
          onClick={() => {
            setMobileNavOpen(false);
          }}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-card transition-transform duration-200 lg:hidden',
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="absolute right-2 top-4">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('nav.closeMenu')}
            onClick={() => {
              setMobileNavOpen(false);
            }}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <SidebarContent
          companyName={companyName}
          companyLogo={companyLogo}
          onNavClick={() => {
            setMobileNavOpen(false);
          }}
          visibleNavItems={visibleNavItems}
        />
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="flex items-center gap-3 border-b p-4 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('nav.openMenu')}
            onClick={() => {
              setMobileNavOpen(true);
            }}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <img
              src={companyLogo ?? '/evtivity-logo-animated.svg'}
              alt={companyName}
              className="h-7 w-7 object-contain"
            />
            <span className="text-lg font-bold">{companyName}</span>
          </div>
        </header>
        <main className="flex-1 overflow-auto bg-background px-4 py-4 lg:px-6 lg:py-6">
          <Outlet />
        </main>
      </div>
      <AiAssistant />
    </div>
  );
}
