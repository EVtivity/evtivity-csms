// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Defaults a new driver account takes when the request sets none (Settings >
 * Company): the time zone (`system.timezone`), the distance unit
 * (`system.distanceUnit`) and the language (`system.driverLanguage`).
 * Browser-safe, so the CSMS imports it via `@evtivity/lib/driver-defaults`.
 */

import { isUiLanguage, type UiLanguage } from './languages.js';
import { DEFAULT_TIMEZONE, isValidTimezone } from './timezone.js';

export const SYSTEM_TIMEZONE_KEY = 'system.timezone';
export const SYSTEM_DISTANCE_UNIT_KEY = 'system.distanceUnit';
export const SYSTEM_DRIVER_LANGUAGE_KEY = 'system.driverLanguage';

export const DISTANCE_UNITS = ['miles', 'km'] as const;
export type DistanceUnit = (typeof DISTANCE_UNITS)[number];

/** The `system.distanceUnit` setting when it is unset or invalid. */
export const DEFAULT_DISTANCE_UNIT: DistanceUnit = 'miles';
/** The `system.driverLanguage` setting when it is unset or invalid. */
export const DEFAULT_DRIVER_LANGUAGE: UiLanguage = 'en';

export function isDistanceUnit(value: unknown): value is DistanceUnit {
  return typeof value === 'string' && (DISTANCE_UNITS as readonly string[]).includes(value);
}

/** The preferences a new driver starts with. */
export interface DriverDefaults {
  timezone: string;
  distanceUnit: DistanceUnit;
  language: UiLanguage;
}

/**
 * The defaults from the stored settings values (key to value). An unset or
 * invalid value falls back to America/New_York, miles and en.
 */
export function readDriverDefaults(values: Record<string, unknown>): DriverDefaults {
  const timezone = values[SYSTEM_TIMEZONE_KEY];
  const distanceUnit = values[SYSTEM_DISTANCE_UNIT_KEY];
  const language = values[SYSTEM_DRIVER_LANGUAGE_KEY];
  return {
    timezone:
      typeof timezone === 'string' && timezone !== '' && isValidTimezone(timezone)
        ? timezone
        : DEFAULT_TIMEZONE,
    distanceUnit: isDistanceUnit(distanceUnit) ? distanceUnit : DEFAULT_DISTANCE_UNIT,
    language: isUiLanguage(language) ? language : DEFAULT_DRIVER_LANGUAGE,
  };
}

/**
 * The preferences of a new driver: each value the request sent, else the
 * company default.
 */
export function newDriverPreferences(
  sent: {
    timezone?: string | undefined;
    distanceUnit?: string | undefined;
    language?: string | undefined;
  },
  defaults: DriverDefaults,
): { timezone: string; distanceUnit: string; language: string } {
  return {
    timezone: sent.timezone ?? defaults.timezone,
    distanceUnit: sent.distanceUnit ?? defaults.distanceUnit,
    language: sent.language ?? defaults.language,
  };
}
