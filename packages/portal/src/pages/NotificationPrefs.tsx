// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/PageHeader';
import { AccountNotificationPrefs } from '@/components/account/AccountNotificationPrefs';

export function NotificationPrefs(): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <PageHeader title={t('account.notificationPrefs')} />
      <AccountNotificationPrefs />
    </div>
  );
}
