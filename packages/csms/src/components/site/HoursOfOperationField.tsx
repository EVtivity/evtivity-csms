// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface HoursOfOperationFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

export function HoursOfOperationField({
  id,
  value,
  onChange,
}: HoursOfOperationFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t('sites.hoursOfOperation')}</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder={t('sites.hoursOfOperationPlaceholder')}
        rows={3}
      />
    </div>
  );
}
