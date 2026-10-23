// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Data retention settings: how many days each kind of stored data is kept
 * before a prune job deletes it. Edited only in Settings > Data Retention
 * (`PUT /v1/settings/data-retention`). Browser-safe, so the CSMS imports it
 * via `@evtivity/lib/data-retention`.
 */

import { AI_LIMIT_SETTINGS, AI_THRESHOLD_SETTINGS, parseAiLimitValue } from './ai-config.js';
import { AI_INSIGHT_SETTING_KEYS } from './ai-insights.js';
import { SIM_RETENTION_DAYS, SIM_SETTING_KEYS, isSimRetentionDays } from './sim-settings.js';

export const DATA_RETENTION_GROUPS = [
  'operationalLogs',
  'securityAudit',
  'signInTokens',
  'ai',
  'sim',
] as const;
export type DataRetentionGroup = (typeof DATA_RETENTION_GROUPS)[number];

export interface DataRetentionDefinition {
  group: DataRetentionGroup;
  defaultDays: number;
  min: number;
  max: number;
  /** 0 keeps the rows forever: the prune job skips a value of 0 or less. */
  keepForever: boolean;
  /**
   * The fewest days a kept value may be, above `min` (which is 0 for "keep
   * forever"): the security history takes 0 or 30 to 3650.
   */
  keptMin?: number;
}

/** The fewest days the audit, sign-in and security event history is kept. */
export const SECURITY_HISTORY_MIN_DAYS = 30;

/** Upper bound of the settings whose job takes any whole number (10 years). */
export const DATA_RETENTION_MAX_DAYS = 3650;

function logs(group: DataRetentionGroup, defaultDays: number): DataRetentionDefinition {
  return {
    group,
    defaultDays,
    min: 0,
    max: DATA_RETENTION_MAX_DAYS,
    keepForever: true,
    ...(group === 'securityAudit' ? { keptMin: SECURITY_HISTORY_MIN_DAYS } : {}),
  };
}

const conversation = AI_LIMIT_SETTINGS['ai.conversationRetentionDays'];
const insights = AI_THRESHOLD_SETTINGS[AI_INSIGHT_SETTING_KEYS.retentionDays];

/** Every retention setting in display order, with its range and default. */
export const DATA_RETENTION_SETTINGS = Object.freeze({
  'logs.ocppMessage.retentionDays': logs('operationalLogs', 30),
  'logs.meterValues.retentionDays': logs('operationalLogs', 90),
  'logs.domainEvents.retentionDays': logs('operationalLogs', 30),
  'logs.access.retentionDays': logs('operationalLogs', 30),
  'logs.workerJob.retentionDays': logs('operationalLogs', 30),
  'logs.portStatus.retentionDays': logs('operationalLogs', 30),
  'logs.connection.retentionDays': logs('operationalLogs', 90),
  'logs.notifications.retentionDays': logs('operationalLogs', 90),
  'logs.loadAllocation.retentionDays': logs('operationalLogs', 90),
  'audit.retentionDays': logs('securityAudit', 1095),
  'logs.loginAudit.retentionDays': logs('securityAudit', 90),
  'logs.securityEvents.retentionDays': logs('securityAudit', 365),
  'refreshTokens.retentionDays': logs('signInTokens', 30),
  'ai.conversationRetentionDays': {
    group: 'ai',
    defaultDays: conversation.defaultValue,
    min: conversation.min,
    max: conversation.max,
    keepForever: false,
  },
  [AI_INSIGHT_SETTING_KEYS.retentionDays]: {
    group: 'ai',
    defaultDays: insights.defaultValue,
    min: insights.min,
    max: insights.max,
    keepForever: false,
  },
  [SIM_SETTING_KEYS.retentionDays]: {
    group: 'sim',
    defaultDays: SIM_RETENTION_DAYS.default,
    min: SIM_RETENTION_DAYS.min,
    max: SIM_RETENTION_DAYS.max,
    keepForever: false,
  },
} as const satisfies Record<string, DataRetentionDefinition>);

export type DataRetentionSettingKey = keyof typeof DATA_RETENTION_SETTINGS;

export const DATA_RETENTION_KEYS = Object.freeze(
  Object.keys(DATA_RETENTION_SETTINGS) as DataRetentionSettingKey[],
);

export function isDataRetentionSettingKey(key: string): key is DataRetentionSettingKey {
  return Object.hasOwn(DATA_RETENTION_SETTINGS, key);
}

/**
 * Whether a whole number of days is a valid value of a retention setting: in
 * `min` to `max`, and for the security history 0 or at least `keptMin`.
 */
export function isAllowedRetentionDays(key: DataRetentionSettingKey, days: number): boolean {
  const def: DataRetentionDefinition = DATA_RETENTION_SETTINGS[key];
  if (!Number.isInteger(days) || days < def.min || days > def.max) return false;
  return def.keptMin == null || days === 0 || days >= def.keptMin;
}

/**
 * True when a change shortens how long the audit, sign-in or security event
 * history is kept: fewer days, or a number of days where 0 kept it forever.
 * Such a change takes a fresh proof from a session and sends a security
 * notice. `before` is the effective value, `after` the new one.
 */
export function shortensSecurityHistory(
  key: DataRetentionSettingKey,
  before: number,
  after: number,
): boolean {
  if (DATA_RETENTION_SETTINGS[key].group !== 'securityAudit') return false;
  if (after <= 0) return false;
  return before <= 0 || after < before;
}

/**
 * The days the prune job uses for a stored value: the log, audit and refresh
 * token jobs take any number (0 or less keeps the rows), the AI and SIM
 * readers take a whole number in range, else the default.
 */
export function effectiveRetentionDays(key: DataRetentionSettingKey, raw: unknown): number {
  const def: DataRetentionDefinition = DATA_RETENTION_SETTINGS[key];
  if (key === 'ai.conversationRetentionDays' || key === AI_INSIGHT_SETTING_KEYS.retentionDays) {
    return parseAiLimitValue(key, raw) ?? def.defaultDays;
  }
  if (key === SIM_SETTING_KEYS.retentionDays) {
    return isSimRetentionDays(raw) ? raw : def.defaultDays;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def.defaultDays;
  if (raw <= 0) return 0;
  // A kept security history never goes below its floor, also for a value
  // written around the API.
  return def.keptMin != null && raw < def.keptMin ? def.keptMin : raw;
}
