// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { UserCircle, LogOut, User, Languages, Check, Sun, Moon } from 'lucide-react';
import { SpeedDial } from '@/components/SpeedDial';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const languages = [
  { code: 'en', label: 'English (US)', flag: '\u{1F1FA}\u{1F1F8}' },
  { code: 'en-GB', label: 'English (UK)', flag: '\u{1F1EC}\u{1F1E7}' },
  { code: 'es', label: 'Espanol', flag: '\u{1F1EA}\u{1F1F8}' },
  { code: 'ko', label: '\uD55C\uAD6D\uC5B4', flag: '\u{1F1F0}\u{1F1F7}' },
  { code: 'zh', label: '\u7B80\u4F53\u4E2D\u6587', flag: '\u{1F1E8}\u{1F1F3}' },
  { code: 'zh-TW', label: '\u7E41\u9AD4\u4E2D\u6587', flag: '\u{1F1F9}\u{1F1FC}' },
];

interface UserDropdownProps {
  collapsed: boolean;
  onNavClick?: (() => void) | undefined;
}

export function UserDropdown({ collapsed, onNavClick }: UserDropdownProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const logout = useAuth((s) => s.logout);
  const setLanguage = useAuth((s) => s.setLanguage);
  const setTheme = useAuth((s) => s.setTheme);
  const theme = useAuth((s) => s.theme);
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();

  return (
    <div className={cn(collapsed ? 'p-2' : 'p-4')}>
      <SpeedDial
        collapsed={collapsed}
        trigger={
          user?.firstName != null || user?.lastName != null ? (
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary',
              )}
            >
              {(user.firstName?.[0] ?? '').toUpperCase()}
              {(user.lastName?.[0] ?? '').toUpperCase()}
            </span>
          ) : (
            <User className="h-4 w-4 shrink-0" />
          )
        }
        triggerLabel={user?.email}
        actions={[
          {
            key: 'profile',
            icon: <UserCircle className="h-4 w-4" />,
            label: t('nav.profile'),
            onClick: () => {
              onNavClick?.();
              void navigate('/profile');
            },
          },
          {
            key: 'language',
            icon: <Languages className="h-4 w-4" />,
            label: t('nav.language'),
            onClick: () => {},
          },
          {
            key: 'theme',
            icon: theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />,
            label: t('nav.theme'),
            onClick: () => {
              void setTheme(theme === 'light' ? 'dark' : 'light');
            },
          },
          {
            key: 'logout',
            icon: <LogOut className="h-4 w-4" />,
            label: t('nav.logOut'),
            onClick: logout,
          },
        ]}
        subMenu={{
          key: 'language',
          backLabel: t('nav.back'),
          items: languages.map((lang) => ({
            key: lang.code,
            icon: collapsed ? (
              <span className="text-sm leading-none">{lang.flag}</span>
            ) : i18n.language === lang.code ? (
              <Check className="h-4 w-4 text-primary" />
            ) : (
              <span className="h-4 w-4" />
            ),
            label: lang.label,
            onClick: () => {
              void setLanguage(lang.code);
            },
          })),
        }}
      />
    </div>
  );
}
