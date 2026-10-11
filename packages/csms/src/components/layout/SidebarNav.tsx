// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { NavLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import type { ParseKeys } from 'i18next';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { Tooltip } from '@/components/ui/tooltip';
import { usePendingProposalCount } from '@/components/ai/inbox/proposal-api';

/**
 * A nav item's count (AI Inbox pending proposals, unread support cases), as a
 * pill (expanded) or a dot (collapsed). Every nav count uses this one style.
 */
function NavCountBadge({
  count,
  collapsed,
  label,
  testId,
}: {
  count: number;
  collapsed: boolean;
  label: string;
  testId: string;
}): React.JSX.Element {
  if (collapsed) {
    return (
      <span
        className="absolute -right-1 -top-1 flex h-2 w-2 rounded-full bg-warning"
        role="status"
        aria-label={label}
        data-testid={testId}
      />
    );
  }
  return (
    <span
      className="ml-auto rounded-full bg-warning px-1.5 text-xs font-semibold leading-5 text-warning-foreground"
      role="status"
      aria-label={label}
      data-testid={testId}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export interface NavItem {
  to: string;
  labelKey: ParseKeys;
  icon: LucideIcon;
}

interface SidebarNavProps {
  items: readonly NavItem[];
  collapsed: boolean;
  onNavClick?: (() => void) | undefined;
}

interface NavBadge {
  count: number;
  label: string;
  testId: string;
}

export function SidebarNav({ items, collapsed, onNavClick }: SidebarNavProps): React.JSX.Element {
  const { t } = useTranslation();

  const canReadSupport = useHasPermission('support:read');
  const hasSupportAccess = canReadSupport && items.some((item) => item.to === '/support-cases');
  // The unread cases assigned to the user: the bold rows of the list. ai_assist
  // cases are left out until escalated (driver-ai-support.md, D1).
  const { data: unreadCountData } = useQuery({
    queryKey: ['support-cases-unread-count'],
    queryFn: () => api.get<{ count: number }>('/v1/support-cases/unread-count'),
    refetchInterval: 60_000,
    enabled: hasSupportAccess,
  });
  const unreadCaseCount = hasSupportAccess ? (unreadCountData?.count ?? 0) : 0;
  const hasInbox = items.some((item) => item.to === '/ai/inbox');
  const pendingProposals = usePendingProposalCount(hasInbox);

  function badgeFor(to: string): NavBadge | null {
    if (to === '/ai/inbox' && pendingProposals > 0) {
      return {
        count: pendingProposals,
        label: t('aiInbox.pendingCount', { count: pendingProposals }),
        testId: 'ai-inbox-badge',
      };
    }
    if (to === '/support-cases' && unreadCaseCount > 0) {
      return {
        count: unreadCaseCount,
        label: t('nav.unreadCasesCount', { count: unreadCaseCount }),
        testId: 'support-cases-badge',
      };
    }
    return null;
  }

  return (
    <nav className={cn('flex-1 overflow-y-auto space-y-1', collapsed ? 'p-2' : 'p-4')}>
      {items.map((item) => {
        const badge = badgeFor(item.to);
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
                  ? 'bg-primary/10 text-link'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )
            }
          >
            {collapsed && badge != null ? (
              <span className="relative">
                <item.icon className="h-4 w-4 shrink-0" />
                <NavCountBadge
                  count={badge.count}
                  collapsed
                  label={badge.label}
                  testId={badge.testId}
                />
              </span>
            ) : (
              <item.icon className="h-4 w-4 shrink-0" />
            )}
            {!collapsed && label}
            {!collapsed && badge != null && (
              <NavCountBadge
                count={badge.count}
                collapsed={false}
                label={badge.label}
                testId={badge.testId}
              />
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
