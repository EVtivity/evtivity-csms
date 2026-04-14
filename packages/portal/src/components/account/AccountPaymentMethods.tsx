// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';

interface PaymentMethod {
  id: number;
  cardBrand: string | null;
  cardLast4: string | null;
  isDefault: boolean;
}

export function AccountPaymentMethods(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { data: methods } = useQuery({
    queryKey: ['portal-payment-methods'],
    queryFn: () => api.get<PaymentMethod[]>('/v1/portal/payment-methods'),
  });

  return (
    <div className="space-y-3">
      {methods != null && methods.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('payments.noMethods')}</p>
      )}
      {methods?.map((pm) => (
        <div key={pm.id} className="flex items-center gap-3">
          <CreditCard className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm">
            {t('payments.cardEnding', {
              brand: pm.cardBrand ?? 'Card',
              last4: pm.cardLast4 ?? '****',
            })}
          </span>
          {pm.isDefault && <Badge variant="secondary">{t('common.default')}</Badge>}
        </div>
      ))}
      <button
        onClick={() => {
          void navigate('/payment-methods');
        }}
        className="flex items-center gap-1 text-sm text-primary hover:underline"
      >
        {t('account.managePayments')}
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
