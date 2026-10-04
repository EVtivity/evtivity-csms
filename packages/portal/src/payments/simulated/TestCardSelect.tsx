// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { FlaskConical } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select } from '@/components/ui/select';
import { testCardLabel, type TestCard } from './cards';

/** "Test mode, no real money" banner shown on every simulated form. */
export function TestModeNotice(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Alert variant="warning">
      <FlaskConical className="h-4 w-4" />
      <AlertDescription>{t('paymentProviders.simulated.testMode')}</AlertDescription>
    </Alert>
  );
}

export interface TestCardSelectProps {
  id: string;
  cards: TestCard[];
  value: string;
  disabled: boolean;
  onChange: (number: string) => void;
}

/** Select of the allowlisted test cards. No free text: only these numbers reach the API. */
export function TestCardSelect({
  id,
  cards,
  value,
  disabled,
  onChange,
}: TestCardSelectProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium leading-6">
        {t('paymentProviders.simulated.testCard')}
      </label>
      <Select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        {cards.map((card) => (
          <option key={card.number} value={card.number}>
            {testCardLabel(card, t)}
          </option>
        ))}
      </Select>
    </div>
  );
}
