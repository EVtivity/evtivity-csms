// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
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

interface TariffRestrictions {
  timeRange?: { startTime: string; endTime: string };
  daysOfWeek?: number[];
  dateRange?: { startDate: string; endDate: string };
  holidays?: boolean;
  energyThresholdKwh?: number;
}

interface ScheduleItem {
  id: string;
  name: string;
  currency: string;
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  taxRate: string | null;
  restrictions: TariffRestrictions | null;
  priority: number;
  isDefault: boolean;
  isCurrent: boolean;
}

interface PricingGroupScheduleTabProps {
  groupId: string;
}

export function PricingGroupScheduleTab({
  groupId,
}: PricingGroupScheduleTabProps): React.JSX.Element {
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

  const { data: schedule, isLoading: scheduleLoading } = useQuery({
    queryKey: ['tariff-schedule', groupId],
    queryFn: () => api.get<ScheduleItem[]>(`/v1/pricing-groups/${groupId}/schedule`),
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
    return parts.join(' ') || '--';
  }

  function formatCompactRates(item: ScheduleItem): string {
    const parts: string[] = [];
    if (item.pricePerKwh != null) parts.push(`${item.currency} ${item.pricePerKwh}/kWh`);
    if (item.pricePerMinute != null) parts.push(`${item.pricePerMinute}/min`);
    if (item.pricePerSession != null) parts.push(`${item.pricePerSession}/session`);
    return parts.length > 0 ? parts.join(' + ') : t('pricing.free');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pricing.schedule')}</CardTitle>
      </CardHeader>
      <CardContent>
        {scheduleLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}

        {schedule != null && schedule.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('pricing.noTariffsFound')}</p>
        )}

        {schedule != null && schedule.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('pricing.tariffName')}</TableHead>
                  <TableHead>{t('pricing.tariffType')}</TableHead>
                  <TableHead>{t('pricing.priority')}</TableHead>
                  <TableHead>{t('pricing.costFormula')}</TableHead>
                  <TableHead>{t('pricing.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedule.map((item) => (
                  <TableRow key={item.id} className={item.isCurrent ? 'bg-primary/5' : ''}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatRestrictionSummary(item.restrictions)}
                    </TableCell>
                    <TableCell>{item.priority}</TableCell>
                    <TableCell className="text-sm">{formatCompactRates(item)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {item.isDefault && (
                          <Badge variant="secondary">{t('pricing.defaultTariff')}</Badge>
                        )}
                        {item.isCurrent && (
                          <Badge variant="success">{t('pricing.isCurrent')}</Badge>
                        )}
                      </div>
                    </TableCell>
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
