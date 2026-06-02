// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import type { ParseKeys } from 'i18next';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { Tooltip } from '@/components/ui/tooltip';

export interface NavItem {
  to: string;
  labelKey: ParseKeys;
  icon: LucideIcon;
  requiredPermission: string | null;
}

interface SidebarNavProps {
  items: readonly NavItem[];
  collapsed: boolean;
  onNavClick?: (() => void) | undefined;
}

export function SidebarNav({ items, collapsed, onNavClick }: SidebarNavProps): React.JSX.Element {
  const { t } = useTranslation();

  const hasSupportAccess = items.some((item) => item.to === '/support-cases');
  const { data: unreadCountData } = useQuery({
    queryKey: ['support-cases-unread-count'],
    queryFn: () => api.get<{ count: number }>('/v1/support-cases/unread-count'),
    refetchInterval: 60_000,
    enabled: hasSupportAccess,
  });
  const unreadCaseCount = unreadCountData?.count ?? 0;

  return (
    <nav className={cn('flex-1 overflow-y-auto space-y-1', collapsed ? 'p-2' : 'p-4')}>
      {items.map((item) => {
        const showDot = item.to === '/support-cases' && unreadCaseCount > 0;
        const label = t(item.labelKey);
        const link = (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            onClick={onNavClick}
            className={({ isActive }) =>
              cn(
                'flex items-center rounded-md text-sm font-medium transition-colors',
                collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )
            }
          >
            {collapsed && showDot ? (
              <span className="relative">
                <item.icon className="h-4 w-4 shrink-0" />
                <span
                  className="absolute -right-1 -top-1 flex h-2 w-2"
                  aria-label={t('nav.unreadCases')}
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                </span>
              </span>
            ) : (
              <item.icon className="h-4 w-4 shrink-0" />
            )}
            {!collapsed && label}
            {!collapsed && showDot && (
              <span className="relative ml-auto flex h-2 w-2" aria-label={t('nav.unreadCases')}>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
            )}
          </NavLink>
        );

        // When the sidebar is collapsed the labels are hidden, so wrap each
        // icon in a right-side tooltip so operators can see which page each
        // icon goes to without expanding the sidebar. The design-system
        // Tooltip beats the native `title` attribute on hover delay and
        // styling consistency.
        if (collapsed) {
          return (
            <Tooltip key={item.to} content={label} side="right">
              {link}
            </Tooltip>
          );
        }
        return link;
      })}
    </nav>
  );
}
