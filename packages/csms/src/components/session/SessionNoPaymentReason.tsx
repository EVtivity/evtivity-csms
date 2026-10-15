// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useHasCompanyWidePermission, useHasPermission } from '@/lib/auth';

/** Why a session has no payment record (GET /v1/sessions/:id `noPaymentReason`). */
export type NoPaymentReason =
  | 'free_vend'
  | 'roaming'
  | 'account_credit_limit'
  | 'account_billed'
  | 'guest'
  | 'anonymous'
  | 'no_payment_method'
  | 'payment_failed'
  | 'pending'
  | 'no_cost'
  | 'payments_off'
  | 'prepaid_not_debited'
  | 'not_held';

export interface NoPaymentReasonContext {
  reason: NoPaymentReason;
  /** The billing fleet of an account session. */
  fleetName?: string | null;
  /** The account session goes on the driver's member invoice. */
  memberBilled?: boolean;
  /** The invoice holding the account session, once it is invoiced. */
  invoiceId?: string | null;
  /** Switches the session page to its Guest Session tab. */
  onOpenGuestTab?: () => void;
}

export function SessionNoPaymentReason({
  reason,
  fleetName,
  memberBilled,
  invoiceId,
  onOpenGuestTab,
}: NoPaymentReasonContext): React.JSX.Element {
  const { t } = useTranslation();
  const canOpenPaymentSettings = useHasPermission('settings.payment:read');
  // Invoices are a company-wide route.
  const canOpenInvoice = useHasCompanyWidePermission('payments:read');

  const text =
    reason === 'account_billed'
      ? t(
          memberBilled === true
            ? 'sessions.noPaymentReason.account_billed_member'
            : 'sessions.noPaymentReason.account_billed',
          { fleet: fleetName ?? '' },
        )
      : t(`sessions.noPaymentReason.${reason}`);

  let action: React.ReactNode = null;
  if (reason === 'payments_off' && canOpenPaymentSettings) {
    action = (
      <Link to="/settings?tab=payment" className="text-link hover:underline">
        {t('sessions.noPaymentReason.openPaymentSettings')}
      </Link>
    );
  } else if (reason === 'account_billed' && invoiceId != null && canOpenInvoice) {
    action = (
      <Link to={`/invoices/${invoiceId}`} className="text-link hover:underline">
        {t('sessions.noPaymentReason.viewInvoice')}
      </Link>
    );
  } else if (reason === 'guest' && onOpenGuestTab != null) {
    action = (
      <Button variant="outline" size="sm" onClick={onOpenGuestTab}>
        {t('sessions.noPaymentReason.openGuestTab')}
      </Button>
    );
  }

  return (
    <Alert variant="info" data-testid="no-payment-reason">
      <Info />
      <AlertDescription className="flex flex-1 flex-wrap items-center justify-between gap-2">
        <span>{text}</span>
        {action}
      </AlertDescription>
    </Alert>
  );
}
