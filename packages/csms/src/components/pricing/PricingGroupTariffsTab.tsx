// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CreateButton } from '@/components/create-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { LoadingLogo } from '@/components/loading-logo';

interface TariffRestrictions {
  timeRange?: { startTime: string; endTime: string };
  daysOfWeek?: number[];
  dateRange?: { startDate: string; endDate: string };
  holidays?: boolean;
  energyThresholdKwh?: number;
}

interface Tariff {
  id: string;
  pricingGroupId: string;
  name: string;
  currency: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  isActive: boolean;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute: string | null;
  taxRate: string | null;
  restrictions: TariffRestrictions | null;
  priority: number;
  isDefault: boolean;
  createdAt: string;
}

interface PricingGroupTariffsTabProps {
  groupId: string;
}

export function PricingGroupTariffsTab({
  groupId,
}: PricingGroupTariffsTabProps): React.JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const dayLabels = [
    t('pricing.sunday'),
    t('pricing.monday'),
    t('pricing.tuesday'),
    t('pricing.wednesday'),
    t('pricing.thursday'),
    t('pricing.friday'),
    t('pricing.saturday'),
  ];

  const { data: tariffs, isLoading: tariffsLoading } = useQuery({
    queryKey: ['tariffs', groupId],
    queryFn: () => api.get<Tariff[]>(`/v1/pricing-groups/${groupId}/tariffs`),
  });

  function formatRestrictionSummary(restrictions: TariffRestrictions | null): string {
    if (restrictions == null) return t('pricing.noRestrictions');
    if (restrictions.energyThresholdKwh != null) {
      return `Above ${String(restrictions.energyThresholdKwh)} kWh`;
    }
    if (restrictions.holidays === true) return t('pricing.holiday');
    if (restrictions.dateRange != null) {
      return `${restrictions.dateRange.startDate} - ${restrictions.dateRange.endDate}`;
    }
    const parts: string[] = [];
    if (restrictions.daysOfWeek != null) {
      const names = restrictions.daysOfWeek
        .map((d) => dayLabels[d])
        .filter((s): s is string => s != null);
      parts.push(names.join(', '));
    }
    if (restrictions.timeRange != null) {
      parts.push(`${restrictions.timeRange.startTime} - ${restrictions.timeRange.endTime}`);
    }
    return parts.join(' ') || 'n/a';
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('pricing.tariffs')}</CardTitle>
        <CreateButton
          label={t('pricing.createTariff')}
          onClick={() => {
            void navigate(`/pricing/${groupId}/tariffs/new`);
          }}
        />
      </CardHeader>
      <CardContent>
        {tariffsLoading && <LoadingLogo size="inline" />}

        {tariffs != null && tariffs.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">{t('pricing.noTariffsFound')}</p>
        )}

        {tariffs != null && tariffs.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('pricing.tariffId')}</TableHead>
                  <TableHead>{t('pricing.tariffName')}</TableHead>
                  <TableHead>{t('pricing.tariffType')}</TableHead>
                  <TableHead>{t('pricing.perKwh')}</TableHead>
                  <TableHead>{t('pricing.perMin')}</TableHead>
                  <TableHead>{t('pricing.perSession')}</TableHead>
                  <TableHead>{t('pricing.idleFeePricePerMinute')}</TableHead>
                  <TableHead>{t('pricing.reservationFeePerMinute')}</TableHead>
                  <TableHead>{t('pricing.taxRate')}</TableHead>
                  <TableHead>{t('pricing.currency')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tariffs.map((tariff) => (
                  <TableRow
                    key={tariff.id}
                    className="cursor-pointer"
                    data-testid={`tariff-row-${tariff.id}`}
                    onClick={() => {
                      void navigate(`/pricing/${groupId}/tariffs/${tariff.id}`);
                    }}
                  >
                    <TableCell className="text-muted-foreground">{tariff.id}</TableCell>
                    <TableCell className="font-medium text-primary" data-testid="row-click-target">
                      {tariff.name}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatRestrictionSummary(tariff.restrictions)}
                    </TableCell>
                    <TableCell>{tariff.pricePerKwh ?? 'n/a'}</TableCell>
                    <TableCell>{tariff.pricePerMinute ?? 'n/a'}</TableCell>
                    <TableCell>{tariff.pricePerSession ?? 'n/a'}</TableCell>
                    <TableCell>{tariff.idleFeePricePerMinute ?? 'n/a'}</TableCell>
                    <TableCell>{tariff.reservationFeePerMinute ?? 'n/a'}</TableCell>
                    <TableCell>{tariff.taxRate ?? 'n/a'}</TableCell>
                    <TableCell>{tariff.currency}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
