// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';

export function ProfileAppearance(): React.JSX.Element {
  const { t } = useTranslation();
  const setTheme = useAuth((s) => s.setTheme);
  const authTheme = useAuth((s) => s.theme);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.appearance')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <Label htmlFor="edit-theme">{t('profile.theme')}</Label>
          <select
            id="edit-theme"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={authTheme}
            onChange={(e) => {
              void setTheme(e.target.value as 'light' | 'dark');
            }}
          >
            <option value="light">{t('profile.themeLight')}</option>
            <option value="dark">{t('profile.themeDark')}</option>
          </select>
        </div>
      </CardContent>
    </Card>
  );
}
