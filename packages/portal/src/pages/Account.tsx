// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, ChevronDown, LogOut, Shield, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { AccountPersonalInfo } from '@/components/account/AccountPersonalInfo';
import { AccountSecurity } from '@/components/account/AccountSecurity';
import { AccountNotificationPrefs } from '@/components/account/AccountNotificationPrefs';

interface SectionProps {
  title: string;
  icon?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function Section({ title, icon, open, onToggle, children }: SectionProps): React.JSX.Element {
  return (
    <div className="border-b">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between min-h-12 py-3 text-left"
      >
        <span className="flex items-center gap-2.5 text-sm font-semibold">
          {icon}
          {title}
        </span>
        <ChevronDown
          className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && <div className="pb-4">{children}</div>}
    </div>
  );
}

type SectionKey = 'personalInfo' | 'security' | 'preferences';

export function Account(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const logout = useAuth((s) => s.logout);
  const [openSection, setOpenSection] = useState<SectionKey | null>('personalInfo');

  function toggle(key: SectionKey): void {
    setOpenSection((prev) => (prev === key ? null : key));
  }

  function handleLogout(): void {
    void logout();
    void navigate('/login');
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('account.title')}</h1>

      <Section
        title={t('account.personalInfo')}
        icon={
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
            <User className="h-3.5 w-3.5 text-primary-foreground" />
          </span>
        }
        open={openSection === 'personalInfo'}
        onToggle={() => {
          toggle('personalInfo');
        }}
      >
        <AccountPersonalInfo />
      </Section>

      <Section
        title={t('account.security')}
        icon={
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-success">
            <Shield className="h-3.5 w-3.5 text-success-foreground" />
          </span>
        }
        open={openSection === 'security'}
        onToggle={() => {
          toggle('security');
        }}
      >
        <AccountSecurity />
      </Section>

      <Section
        title={t('account.preferences')}
        icon={
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-warning">
            <Bell className="h-3.5 w-3.5 text-warning-foreground" />
          </span>
        }
        open={openSection === 'preferences'}
        onToggle={() => {
          toggle('preferences');
        }}
      >
        <AccountNotificationPrefs />
      </Section>

      <div className="pt-4">
        <Button variant="outline" size="lg" className="w-full" onClick={handleLogout}>
          <LogOut className="mr-2 h-4 w-4" />
          {t('profile.signOut')}
        </Button>
      </div>
    </div>
  );
}
