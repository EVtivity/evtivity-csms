// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ArrowLeftRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** Where an unbilled account session goes: the fleet invoice or the driver's member invoice. */
export type BillingRecipient = 'fleet' | 'member';

interface BillToButtonProps {
  /** The recipient the click moves the sessions to. */
  recipient: BillingRecipient;
  onClick: () => void;
  /** Overrides the label (a bulk action names all rows). */
  label?: string;
  disabled?: boolean;
  size?: 'default' | 'header';
}

/** Moves unbilled account sessions between the fleet invoice and the member invoice. */
export function BillToButton({
  recipient,
  onClick,
  label,
  disabled,
  size,
}: BillToButtonProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Button variant="outline" size={size} onClick={onClick} disabled={disabled}>
      <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
      {label ??
        (recipient === 'member'
          ? t('billingRecipient.billToDriver')
          : t('billingRecipient.billToFleet'))}
    </Button>
  );
}
