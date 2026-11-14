// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { UI_THEMES, type UiTheme } from '@evtivity/lib/ui-theme';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { UI_THEME_LABEL_KEY } from '@/lib/theme';
import { useAppearanceSave } from '@/hooks/use-appearance-save';

export function ProfileAppearance(): React.JSX.Element {
  const { t } = useTranslation();
  const setTheme = useAuth((s) => s.setTheme);
  const authTheme = useAuth((s) => s.theme);
  const setUiTheme = useAuth((s) => s.setUiTheme);
  const uiTheme = useAuth((s) => s.uiTheme);
  const saveAppearance = useAppearanceSave();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.appearance')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="edit-ui-theme" className="leading-6">
            {t('profile.uiTheme')}
          </Label>
          <Select
            id="edit-ui-theme"
            value={uiTheme}
            aria-describedby="edit-ui-theme-description"
            onChange={(e) => {
              saveAppearance(setUiTheme(e.target.value as UiTheme));
            }}
          >
            {UI_THEMES.map((theme) => (
              <option key={theme} value={theme}>
                {t(UI_THEME_LABEL_KEY[theme])}
              </option>
            ))}
          </Select>
          <p id="edit-ui-theme-description" className="text-sm text-muted-foreground">
            {t(`${UI_THEME_LABEL_KEY[uiTheme]}Description`)}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-theme" className="leading-6">
            {t('profile.theme')}
          </Label>
          <Select
            id="edit-theme"
            value={authTheme}
            onChange={(e) => {
              saveAppearance(setTheme(e.target.value as 'light' | 'dark'));
            }}
          >
            <option value="light">{t('profile.themeLight')}</option>
            <option value="dark">{t('profile.themeDark')}</option>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
