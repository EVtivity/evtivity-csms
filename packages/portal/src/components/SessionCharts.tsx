// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Battery } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { PowerChart } from '@/components/PowerChart';
import { EnergyChart } from '@/components/EnergyChart';
import { formatNumber } from '@/lib/utils';

interface PowerDataPoint {
  timestamp: string;
  powerW: number;
}

interface EnergyDataPoint {
  timestamp: string;
  energyWh: number;
}

interface SessionChartsProps {
  powerData: PowerDataPoint[];
  energyData: EnergyDataPoint[];
  currentPowerW?: number | null;
  batteryPercent?: number | null;
  energyDeliveredWh?: string | null;
}

function formatPower(watts: number | null | undefined): string {
  if (watts == null) return 'n/a';
  if (watts >= 1000) return `${formatNumber(watts / 1000, 1)} kW`;
  return `${formatNumber(watts, 0)} W`;
}

function formatEnergyValue(wh: string | null | undefined): string {
  if (wh == null) return 'n/a';
  const value = parseFloat(wh);
  if (isNaN(value)) return 'n/a';
  return `${formatNumber(value / 1000, 2)} kWh`;
}

export function SessionCharts({
  powerData,
  energyData,
  currentPowerW,
  batteryPercent,
  energyDeliveredWh,
}: SessionChartsProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const hasPower = powerData.length >= 2;
  const hasEnergy = energyData.length >= 2;

  const [activeTab, setActiveTab] = useState<'energy' | 'power'>('energy');

  if (!hasEnergy && !hasPower) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('sessionDetail.energy')}</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div
            className="flex items-center justify-center text-sm text-muted-foreground"
            style={{ height: 160 }}
          >
            {t('sessionDetail.collectingData')}
          </div>
        </CardContent>
      </Card>
    );
  }

  const showTabs = hasPower;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          {showTabs ? (
            <SegmentedControl
              aria-label={t('sessionDetail.chartView')}
              value={activeTab}
              onValueChange={setActiveTab}
              options={[
                { value: 'energy', label: t('sessionDetail.energy') },
                { value: 'power', label: t('sessionDetail.power') },
              ]}
            />
          ) : (
            <CardTitle className="text-sm">{t('sessionDetail.energy')}</CardTitle>
          )}
          <div className="flex items-center gap-3">
            {batteryPercent != null && (
              <span className="flex items-center gap-1 text-sm font-bold text-muted-foreground">
                <Battery className="h-4 w-4" />
                {formatNumber(batteryPercent, 0)}%
              </span>
            )}
            <span className="text-sm font-bold text-link">
              {activeTab === 'power'
                ? formatPower(currentPowerW)
                : formatEnergyValue(energyDeliveredWh)}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        {activeTab === 'energy' ? (
          <EnergyChart data={energyData} height={160} />
        ) : (
          <PowerChart data={powerData} height={160} />
        )}
      </CardContent>
    </Card>
  );
}
