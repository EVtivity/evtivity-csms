// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  User,
  ShieldCheck,
  BellRing,
  LayoutGrid,
  CreditCard,
  Nfc,
  Car,
  Star,
  LifeBuoy,
  ChevronRight,
  LogOut,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';

interface RowProps {
  icon: React.ReactNode;
  title: string;
  to: string;
  divider?: boolean;
}

function Row({ icon, title, to, divider }: RowProps): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() => {
        void navigate(to);
      }}
      className={`flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-accent ${
        divider ? 'border-t border-border' : ''
      }`}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 text-sm font-medium">{title}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}

export function Account(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const driver = useAuth((s) => s.driver);
  const logout = useAuth((s) => s.logout);

  const fullName = driver != null ? `${driver.firstName} ${driver.lastName}`.trim() : '';

  function handleLogout(): void {
    void logout();
    void navigate('/login');
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{fullName.length > 0 ? fullName : t('account.title')}</h1>
        {driver?.email != null && <p className="text-sm text-muted-foreground">{driver.email}</p>}
      </div>

      <Card className="overflow-hidden p-0">
        <Row
          icon={<User className="h-5 w-5" />}
          title={t('account.personalInfo')}
          to="/account/personal"
        />
        <Row
          icon={<ShieldCheck className="h-5 w-5" />}
          title={t('account.security')}
          to="/account/security"
          divider
        />
        <Row
          icon={<BellRing className="h-5 w-5" />}
          title={t('account.notificationPrefs')}
          to="/account/notifications"
          divider
        />
        <Row
          icon={<LayoutGrid className="h-5 w-5" />}
          title={t('account.homeScreen')}
          to="/account/home-cards"
          divider
        />
      </Card>

      <Card className="overflow-hidden p-0">
        <Row
          icon={<CreditCard className="h-5 w-5" />}
          title={t('account.paymentMethods')}
          to="/payment-methods"
        />
        <Row
          icon={<Nfc className="h-5 w-5" />}
          title={t('account.rfidCards')}
          to="/rfid-cards"
          divider
        />
        <Row
          icon={<Car className="h-5 w-5" />}
          title={t('account.vehicles')}
          to="/vehicles"
          divider
        />
      </Card>

      <Card className="overflow-hidden p-0">
        <Row icon={<Star className="h-5 w-5" />} title={t('favorites.title')} to="/favorites" />
        <Row
          icon={<LifeBuoy className="h-5 w-5" />}
          title={t('account.supportCases')}
          to="/support"
          divider
        />
      </Card>

      <Button variant="outline" size="lg" className="w-full" onClick={handleLogout}>
        <LogOut className="mr-2 h-4 w-4" />
        {t('profile.signOut')}
      </Button>
    </div>
  );
}
