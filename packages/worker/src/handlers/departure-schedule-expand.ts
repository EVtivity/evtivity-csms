// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { listExpandableScheduleIds } from '@evtivity/database';
import { expandScheduleOccurrences } from '@evtivity/services/departure.service';

export interface ScheduleExpandResult {
  schedules: number;
  created: number;
  errors: number;
}

/**
 * Creates the missing departures of every active weekly schedule for today and
 * the next 7 local dates of its depot. Runs while fleet charging is off too, so
 * schedules entered before the switch have their departures. Each schedule is
 * read again under a shared lock and stored occurrences are kept, so a run that
 * repeats or races a schedule edit creates nothing twice. One failed schedule
 * is logged and the others continue.
 */
export async function runDepartureScheduleExpand(
  log: Logger,
  now: Date = new Date(),
): Promise<ScheduleExpandResult> {
  // The UTC date only prefilters by valid_to, with a day of slack (valid_to >=
  // UTC date - 1): every depot's local date is within a day of it. Each schedule
  // then expands from its depot's own local date.
  const ids = await listExpandableScheduleIds(now.toISOString().slice(0, 10));
  const result: ScheduleExpandResult = { schedules: ids.length, created: 0, errors: 0 };
  for (const id of ids) {
    try {
      result.created += (await expandScheduleOccurrences(id, now)).length;
    } catch (err: unknown) {
      result.errors++;
      log.warn({ err, scheduleId: id }, 'Departure schedule not expanded, retried next run');
    }
  }
  return result;
}

/** Cron `departure-schedule-expand` (every 15 minutes). */
export async function departureScheduleExpandHandler(log: Logger): Promise<void> {
  const result = await runDepartureScheduleExpand(log);
  log[result.errors > 0 ? 'warn' : 'info'](result, 'Departure schedules expanded');
}
