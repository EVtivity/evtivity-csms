// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { REPORT_PERIODS, isReportPeriod, type ReportPeriod } from '@evtivity/lib/report-period';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

interface ReportPeriodFieldProps {
  id: string;
  value: ReportPeriod;
  onChange: (period: ReportPeriod) => void;
}

export function ReportPeriodField({
  id,
  value,
  onChange,
}: ReportPeriodFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="leading-6">
        {t('reports.reportPeriod')}
      </Label>
      <Select
        id={id}
        value={value}
        onChange={(e) => {
          if (isReportPeriod(e.target.value)) onChange(e.target.value);
        }}
      >
        {REPORT_PERIODS.map((period) => (
          <option key={period} value={period}>
            {t(`reports.periods.${period}`)}
          </option>
        ))}
      </Select>
      <p className="text-xs text-muted-foreground">{t('reports.reportPeriodHelper')}</p>
    </div>
  );
}
