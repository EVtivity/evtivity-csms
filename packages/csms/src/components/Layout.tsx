// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  Building2,
  Fuel,
  Clock,
  Users,
  CreditCard,
  UserCircle,
  Truck,
  Key,
  Settings,
  MessageSquare,
  Bell,
  ScrollText,
  CalendarClock,
  FileBarChart,
  Globe,
  Shield,
  Menu,
  X,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { AiAssistant } from '@/components/AiAssistant';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { UserDropdown } from '@/components/layout/UserDropdown';
import { useAuth, useHasAnyPermission } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useEventStream } from '@/hooks/use-event-stream';
import { api } from '@/lib/api';

function hasPermCheck(userPermissions: string[], required: string): boolean {
  if (userPermissions.includes(required)) return true;
  if (required.endsWith(':read')) {
    const writeVersion = required.replace(':read', ':write');
    if (userPermissions.includes(writeVersion)) return true;
  }
  return false;
}

const navItems = [
  // Overview
  {
    to: '/',
    labelKey: 'nav.dashboard' as const,
    icon: LayoutDashboard,
    requiredPermission: 'dashboard:read',
  },
  // Infrastructure
  {
    to: '/sites',
    labelKey: 'nav.sites' as const,
    icon: Building2,
    requiredPermission: 'sites:read',
  },
  {
    to: '/stations',
    labelKey: 'nav.stations' as const,
    icon: Fuel,
    requiredPermission: 'stations:read',
  },

  // Operations
  {
    to: '/sessions',
    labelKey: 'nav.sessions' as const,
    icon: Clock,
    requiredPermission: 'sessions:read',
  },
  {
    to: '/reservations',
    labelKey: 'nav.reservations' as const,
    icon: CalendarClock,
    requiredPermission: 'reservations:read',
  },
  // Customers
  {
    to: '/drivers',
    labelKey: 'nav.drivers' as const,
    icon: UserCircle,
    requiredPermission: 'drivers:read',
  },
  {
    to: '/fleets',
    labelKey: 'nav.fleets' as const,
    icon: Truck,
    requiredPermission: 'fleets:read',
  },
  { to: '/tokens', labelKey: 'nav.tokens' as const, icon: Key, requiredPermission: 'drivers:read' },
  // Financial
  {
    to: '/pricing',
    labelKey: 'nav.pricing' as const,
    icon: CreditCard,
    requiredPermission: 'pricing:read',
  },
  {
    to: '/reports',
    labelKey: 'nav.reports' as const,
    icon: FileBarChart,
    requiredPermission: 'reports:read',
  },
  // Networking
  {
    to: '/roaming',
    labelKey: 'nav.roaming' as const,
    icon: Globe,
    requiredPermission: 'roaming:read',
  },
  {
    to: '/certificates',
    labelKey: 'nav.certificates' as const,
    icon: Shield,
    requiredPermission: 'certificates:read',
  },
  // Administration
  { to: '/users', labelKey: 'nav.users' as const, icon: Users, requiredPermission: 'users:read' },
  {
    to: '/support-cases',
    labelKey: 'nav.supportCases' as const,
    icon: MessageSquare,
    requiredPermission: 'support:read',
  },
  {
    to: '/notifications',
    labelKey: 'nav.notifications' as const,
    icon: Bell,
    requiredPermission: 'notifications:read',
  },
  { to: '/logs', labelKey: 'nav.logs' as const, icon: ScrollText, requiredPermission: 'logs:read' },
  { to: '/settings', labelKey: 'nav.settings' as const, icon: Settings, requiredPermission: null },
];

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
  visibleNavItems: typeof navItems;
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <>
      <div className={cn('p-6', collapsed && 'flex flex-col items-center px-2 py-4')}>
        <div className={cn('flex items-center gap-2', collapsed && 'justify-center')}>
          <Link to="/" className="flex items-center gap-2">
            <img
              src={companyLogo ?? '/evtivity-logo.svg'}
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

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/settings'),
  });
  const companyName =
    settings != null &&
    typeof settings['company.name'] === 'string' &&
    settings['company.name'] !== ''
      ? settings['company.name']
      : 'EVtivity';
  const companyLogo =
    settings != null &&
    typeof settings['company.logo'] === 'string' &&
    settings['company.logo'] !== ''
      ? settings['company.logo']
      : null;

  useEffect(() => {
    document.title = `${companyName} CSMS`;
    const favicon =
      settings != null &&
      typeof settings['company.favicon'] === 'string' &&
      settings['company.favicon'] !== ''
        ? settings['company.favicon']
        : '';
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
  }, [companyName, settings]);

  const permissions = useAuth((s) => s.permissions);
  const hasAnySettings = useHasAnyPermission([
    'settings.system:read',
    'settings.notification:read',
    'settings.payment:read',
    'settings.integrations:read',
    'settings.security:read',
    'settings.apiKeys:read',
    'settings.firmware:read',
    'settings.stationConfig:read',
    'settings.smartCharging:read',
    'settings.ai:read',
    'settings.conformance:read',
  ]);
  const roamingEnabled = settings != null && settings['roaming.enabled'] === true;
  const pncEnabled = settings != null && settings['pnc.enabled'] === true;
  const reservationEnabled = settings == null || settings['reservation.enabled'] !== false;
  const supportEnabled = settings == null || settings['support.enabled'] !== false;
  const fleetEnabled = settings == null || settings['fleet.enabled'] !== false;
  const visibleNavItems = navItems.filter((item) => {
    if (item.to === '/roaming' && !roamingEnabled) return false;
    if (item.to === '/certificates' && !pncEnabled) return false;
    if (item.to === '/reservations' && !reservationEnabled) return false;
    if (item.to === '/support-cases' && !supportEnabled) return false;
    if (item.to === '/fleets' && !fleetEnabled) return false;
    // Settings nav: show only when user has any settings.* permission
    if (item.to === '/settings') return hasAnySettings;
    // Permission-based filtering for all other nav items
    if (item.requiredPermission != null) {
      return hasPermCheck(permissions, item.requiredPermission);
    }
    return true;
  });

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'hidden md:flex flex-col border-r bg-card transition-all duration-200',
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
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
          onClick={() => {
            setMobileNavOpen(false);
          }}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-card transition-transform duration-200 md:hidden',
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
        <header className="flex items-center gap-3 border-b p-4 md:hidden">
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
              src={companyLogo ?? '/evtivity-logo.svg'}
              alt={companyName}
              className="h-7 w-7 object-contain"
            />
            <span className="text-lg font-bold">{companyName}</span>
          </div>
        </header>
        <main className="flex-1 overflow-auto bg-background px-4 py-4 md:px-6 md:py-6">
          <Outlet />
        </main>
      </div>
      <AiAssistant />
    </div>
  );
}
