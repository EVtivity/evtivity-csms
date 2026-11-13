// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { loginPathFor } from '@/lib/return-path';
import { useRegistrationStatus } from '@/hooks/use-registration-enabled';

/**
 * Where guest payment is not offered, the guest charges with an account:
 * Sign In (back to this charger page after sign-in) and Register (only while
 * drivers may create their own account). Says nothing about payment setup.
 */
export function GuestAccountPrompt(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const registrationOpen = useRegistrationStatus().state === 'open';
  // The checkout step returns to its charger page, which signed-in drivers leave for /start.
  const chargerPath = location.pathname.replace(/\/checkout$/, '');
  return (
    <div className="space-y-2" data-testid="guest-account-prompt">
      <p className="text-center text-sm text-muted-foreground">{t('charger.signInToCharge')}</p>
      <Button
        className="w-full"
        size="lg"
        onClick={() => {
          void navigate(loginPathFor(`${chargerPath}${location.search}`));
        }}
      >
        {t('charger.signIn')}
      </Button>
      {registrationOpen && (
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            void navigate('/register');
          }}
        >
          {t('charger.register')}
        </Button>
      )}
    </div>
  );
}
