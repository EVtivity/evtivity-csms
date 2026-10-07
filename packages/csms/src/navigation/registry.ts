// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

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
  History,
  CalendarClock,
  FileBarChart,
  Globe,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import type { ParseKeys } from 'i18next';
import { permissionCatalog } from '@evtivity/lib/permissions';
import { hasPermissionCheck } from '@/lib/auth';
import type { NavFeatureFlags } from '@/hooks/use-feature-flags';

export interface NavEntry {
  to: string;
  labelKey: ParseKeys;
  icon: LucideIcon;
  /** Sort position in the sidebar, ascending. */
  order: number;
  /** The entry shows when the user holds this permission, or any of them for a list. */
  requiredPermission: string | readonly string[];
  /** Feature toggle check. Omitted: always visible to users with the permission. */
  isVisible?: (flags: NavFeatureFlags) => boolean;
}

/** Every settings tab's read permission: the Settings entry shows when the user holds any. */
const SETTINGS_NAV_PERMISSIONS = permissionCatalog
  .groups()
  .filter((g) => g.kind === 'settings')
  .map((g) => `${g.resource}:read`);

/**
 * The CSMS sidebar. A new page adds one entry here; its route guard in
 * `App.tsx` uses the same permission.
 */
export const NAV_ENTRIES: readonly NavEntry[] = [
  // Overview
  {
    to: '/',
    labelKey: 'nav.dashboard',
    icon: LayoutDashboard,
    order: 10,
    requiredPermission: 'dashboard:read',
  },
  // Infrastructure
  {
    to: '/sites',
    labelKey: 'nav.sites',
    icon: Building2,
    order: 20,
    requiredPermission: 'sites:read',
  },
  {
    to: '/stations',
    labelKey: 'nav.stations',
    icon: Fuel,
    order: 30,
    requiredPermission: 'stations:read',
  },
  // Operations
  {
    to: '/sessions',
    labelKey: 'nav.sessions',
    icon: Clock,
    order: 40,
    requiredPermission: 'sessions:read',
  },
  {
    to: '/reservations',
    labelKey: 'nav.reservations',
    icon: CalendarClock,
    order: 50,
    requiredPermission: 'reservations:read',
    isVisible: (flags) => flags.reservationEnabled,
  },
  // Customers
  {
    to: '/drivers',
    labelKey: 'nav.drivers',
    icon: UserCircle,
    order: 60,
    requiredPermission: 'drivers:read',
  },
  {
    to: '/fleets',
    labelKey: 'nav.fleets',
    icon: Truck,
    order: 70,
    requiredPermission: 'fleets:read',
    isVisible: (flags) => flags.fleetEnabled,
  },
  {
    to: '/tokens',
    labelKey: 'nav.tokens',
    icon: Key,
    order: 80,
    requiredPermission: 'drivers:read',
  },
  // Financial
  {
    to: '/pricing',
    labelKey: 'nav.pricing',
    icon: CreditCard,
    order: 90,
    requiredPermission: 'pricing:read',
  },
  {
    to: '/reports',
    labelKey: 'nav.reports',
    icon: FileBarChart,
    order: 100,
    requiredPermission: 'reports:read',
  },
  // Networking
  {
    to: '/roaming',
    labelKey: 'nav.roaming',
    icon: Globe,
    order: 110,
    requiredPermission: 'roaming:read',
    isVisible: (flags) => flags.roamingEnabled,
  },
  {
    to: '/certificates',
    labelKey: 'nav.certificates',
    icon: Shield,
    order: 120,
    requiredPermission: 'certificates:read',
    isVisible: (flags) => flags.pncEnabled,
  },
  // Administration
  {
    to: '/users',
    labelKey: 'nav.users',
    icon: Users,
    order: 130,
    requiredPermission: 'users:read',
  },
  {
    to: '/support-cases',
    labelKey: 'nav.supportCases',
    icon: MessageSquare,
    order: 140,
    requiredPermission: 'support:read',
    isVisible: (flags) => flags.supportEnabled,
  },
  {
    to: '/notifications',
    labelKey: 'nav.notifications',
    icon: Bell,
    order: 150,
    requiredPermission: 'notifications:read',
  },
  {
    to: '/logs',
    labelKey: 'nav.logs',
    icon: ScrollText,
    order: 160,
    requiredPermission: 'logs:read',
  },
  {
    to: '/audit',
    labelKey: 'nav.audit',
    icon: History,
    order: 170,
    requiredPermission: 'audit:read',
  },
  {
    to: '/settings',
    labelKey: 'nav.settings',
    icon: Settings,
    order: 180,
    requiredPermission: SETTINGS_NAV_PERMISSIONS,
  },
];

/** The entries a user with `permissions` sees under `flags`, in sidebar order. */
export function visibleNavEntries(
  permissions: string[],
  flags: NavFeatureFlags,
  entries: readonly NavEntry[] = NAV_ENTRIES,
): NavEntry[] {
  return entries
    .filter((entry) => {
      if (entry.isVisible != null && !entry.isVisible(flags)) return false;
      const required =
        typeof entry.requiredPermission === 'string'
          ? [entry.requiredPermission]
          : entry.requiredPermission;
      return required.some((p) => hasPermissionCheck(permissions, p));
    })
    .sort((a, b) => a.order - b.order);
}
