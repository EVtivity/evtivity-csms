// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface FleetRef {
  id: string;
  name: string;
}

/** How the driver's new sessions are paid, from GET /v1/drivers/:id. */
export interface DriverBilling {
  mode: 'card' | 'account';
  billingFleet: FleetRef | null;
  pricingFleet: FleetRef | null;
  /** driver: a driver pricing group overrides fleet pricing; fleet: pricingFleet prices. */
  pricingSource?: 'driver' | 'fleet' | null;
  pricingGroup?: FleetRef | null;
}

export interface DriverBillingCardProps {
  billing: DriverBilling | undefined;
}

function FleetLink({ fleet, none }: { fleet: FleetRef | null; none: string }): React.JSX.Element {
  if (fleet == null) return <span className="text-muted-foreground">{none}</span>;
  return (
    <Link to={`/fleets/${fleet.id}`} className="text-primary hover:underline">
      {fleet.name}
    </Link>
  );
}

/** The billing mode with the billing fleet and the pricing fleet, which can differ. */
export function DriverBillingCard({ billing }: DriverBillingCardProps): React.JSX.Element | null {
  const { t } = useTranslation();
  if (billing == null) return null;
  const onAccount = billing.mode === 'account';
  return (
    <Card data-testid="driver-billing">
      <CardHeader>
        <CardTitle>{t('drivers.billing.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t('drivers.billing.mode')}</dt>
            <dd>
              <Badge variant={onAccount ? 'info' : 'outline'}>
                {onAccount ? t('drivers.billing.modeAccount') : t('drivers.billing.modeCard')}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('drivers.billing.billingFleet')}</dt>
            <dd className="font-medium">
              <FleetLink fleet={billing.billingFleet} none={t('drivers.billing.none')} />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('drivers.billing.pricingFleet')}</dt>
            <dd className="font-medium">
              {billing.pricingSource === 'driver' ? (
                <span data-testid="driver-pricing-override">
                  {t('drivers.billing.pricingDriverGroup', {
                    group: billing.pricingGroup?.name ?? '',
                  })}
                </span>
              ) : (
                <FleetLink fleet={billing.pricingFleet} none={t('drivers.billing.none')} />
              )}
            </dd>
          </div>
        </dl>
        <p className="text-muted-foreground">
          {onAccount ? t('drivers.billing.helpAccount') : t('drivers.billing.helpCard')}
        </p>
      </CardContent>
    </Card>
  );
}
