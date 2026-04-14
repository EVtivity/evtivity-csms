// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface SchedulePeriod {
  startPeriod: number;
  limit: number;
  numberPhases?: number;
}

interface TimeSlotEditorProps {
  periods: SchedulePeriod[];
  onChange: (periods: SchedulePeriod[]) => void;
  rateUnit: 'W' | 'A';
}

function secondsToTimeString(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function timeStringToSeconds(time: string): number {
  const parts = time.split(':');
  const hours = parseInt(parts[0] ?? '0', 10);
  const minutes = parseInt(parts[1] ?? '0', 10);
  return hours * 3600 + minutes * 60;
}

function sortPeriods(periods: SchedulePeriod[]): SchedulePeriod[] {
  return [...periods].sort((a, b) => a.startPeriod - b.startPeriod);
}

export function TimeSlotEditor({
  periods,
  onChange,
  rateUnit,
}: TimeSlotEditorProps): React.JSX.Element {
  const { t } = useTranslation();

  function addPeriod(): void {
    const lastPeriod = periods[periods.length - 1];
    const newStart = lastPeriod != null ? lastPeriod.startPeriod + 3600 : 0;
    const newPeriods = sortPeriods([
      ...periods,
      { startPeriod: newStart, limit: 0, numberPhases: 3 },
    ]);
    onChange(newPeriods);
  }

  function updatePeriod(index: number, field: keyof SchedulePeriod, value: string): void {
    const sorted = sortPeriods(periods);
    const updated = [...sorted];
    const existing = updated[index];
    if (existing == null) return;

    if (field === 'startPeriod') {
      existing.startPeriod = timeStringToSeconds(value);
    } else if (field === 'limit') {
      existing.limit = parseFloat(value) || 0;
    } else {
      const parsed = parseInt(value, 10);
      if (isNaN(parsed)) {
        delete existing.numberPhases;
      } else {
        existing.numberPhases = parsed;
      }
    }

    onChange(sortPeriods(updated));
  }

  function removePeriod(index: number): void {
    const sorted = sortPeriods(periods);
    onChange(sorted.filter((_, i) => i !== index));
  }

  const sorted = sortPeriods(periods);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('smartCharging.schedulePeriods')}</CardTitle>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={addPeriod}>
          <Plus className="h-4 w-4" />
          {t('smartCharging.addTimeSlot')}
        </Button>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('smartCharging.noTemplates')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('smartCharging.startTime')}</TableHead>
                  <TableHead>
                    {t('smartCharging.powerLimit')} ({rateUnit})
                  </TableHead>
                  <TableHead>{t('smartCharging.phases')}</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((period, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Input
                        type="time"
                        value={secondsToTimeString(period.startPeriod)}
                        onChange={(e) => {
                          updatePeriod(i, 'startPeriod', e.target.value);
                        }}
                        className="w-32"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        step={rateUnit === 'W' ? 100 : 1}
                        value={period.limit}
                        onChange={(e) => {
                          updatePeriod(i, 'limit', e.target.value);
                        }}
                        className="w-32"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={1}
                        max={3}
                        value={period.numberPhases ?? ''}
                        placeholder="3"
                        onChange={(e) => {
                          updatePeriod(i, 'numberPhases', e.target.value);
                        }}
                        className="w-20"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('common.delete')}
                        onClick={() => {
                          removePeriod(i);
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
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
