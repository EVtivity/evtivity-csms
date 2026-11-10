// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { JobsOptions } from 'bullmq';
import type { Logger } from 'pino';
import {
  CSMS_VERSION_URL,
  UPDATE_CHECK_MAX_BYTES,
  UPDATE_CHECK_MIN_INTERVAL_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  parseReleasedCsmsVersion,
  readCappedBody,
} from '@evtivity/lib';
import { safeFetch } from '@evtivity/lib/safe-fetch';
import {
  isCsmsUpdateCheckEnabled,
  readCsmsUpdateCheck,
  recordCsmsUpdateCheck,
} from '@evtivity/database';

export type CsmsUpdateCheckOutcome =
  | { status: 'off' }
  | { status: 'skipped' }
  | { status: 'checked'; latestVersion: string }
  | { status: 'failed'; reason: string };

/**
 * Reads the latest stable CSMS release from the EVtivity website. Returns the
 * version without the leading v, or a short reason. Only the server's address
 * reaches the website: no cookie, credential or install detail is sent.
 */
export async function fetchLatestCsmsVersion(
  fetchFn: typeof safeFetch = safeFetch,
): Promise<{ version: string } | { reason: string }> {
  const res = await fetchFn(CSMS_VERSION_URL, {
    method: 'GET',
    headers: { accept: 'text/plain' },
    signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return { reason: `status_${String(res.status)}` };
  }
  const type = res.headers.get('content-type') ?? '';
  if (type !== '' && !type.toLowerCase().startsWith('text/plain')) {
    await res.body?.cancel();
    return { reason: 'not_text' };
  }
  const body = await readCappedBody(res, UPDATE_CHECK_MAX_BYTES);
  const version = parseReleasedCsmsVersion(body.toString('utf8'));
  if (version == null) return { reason: 'not_a_version' };
  return { version };
}

/**
 * Cron `csms-update-check` (daily, security review case 385): while
 * `system.updateCheckEnabled` is on, reads the version file at most once a
 * day (a hand run within 23 hours of the last try is skipped) and stores it
 * for `GET /v1/system/update-check`. Off: nothing is fetched. A failed read is
 * logged and keeps the last known version (P9: the notice is not critical).
 */
export async function csmsUpdateCheckHandler(
  log: Logger,
  fetchFn: typeof safeFetch = safeFetch,
  now: () => Date = () => new Date(),
): Promise<CsmsUpdateCheckOutcome> {
  if (!(await isCsmsUpdateCheckEnabled())) {
    log.debug('CSMS update check is off');
    return { status: 'off' };
  }
  const at = now();
  const stored = await readCsmsUpdateCheck();
  if (
    stored != null &&
    at.getTime() - stored.attemptedAt.getTime() < UPDATE_CHECK_MIN_INTERVAL_MS
  ) {
    log.debug({ attemptedAt: stored.attemptedAt }, 'CSMS update check ran within the last day');
    return { status: 'skipped' };
  }

  let result: { version: string } | { reason: string };
  try {
    result = await fetchLatestCsmsVersion(fetchFn);
  } catch (err) {
    result = { reason: err instanceof Error ? err.name : 'error' };
  }

  if ('version' in result) {
    await recordCsmsUpdateCheck(result.version, at);
    log.info({ latestVersion: result.version }, 'CSMS update check complete');
    return { status: 'checked', latestVersion: result.version };
  }
  await recordCsmsUpdateCheck(null, at);
  log.warn({ reason: result.reason }, 'CSMS update check failed, keeping the last known version');
  return { status: 'failed', reason: result.reason };
}

/** Job id of the start-up run, so replicas starting together queue one job. */
export const CSMS_UPDATE_CHECK_STARTUP_JOB_ID = 'csms-update-check-startup';

export type CsmsUpdateCheckStartupOutcome = 'off' | 'not_due' | 'queued' | 'failed';

/**
 * Runs the update check once when the worker starts (owner decision
 * 2026-11-10), with the cron rules: nothing while `system.updateCheckEnabled`
 * is off, nothing within 23 hours of the stored last try (also across
 * restarts). It adds one `csms-update-check` job to the cron queue under a
 * fixed job id, so replicas that start together queue a single job; the cron
 * worker runs it under the job's lock and records it like a tick, and the
 * handler checks the 23 hours again, so a job added after the first one
 * finished fetches nothing. Never throws: a failure is logged at warn (P9)
 * and the daily tick still runs.
 */
export async function queueCsmsUpdateCheckAtStartup(
  cronQueue: { add(name: string, data: object, opts: JobsOptions): Promise<unknown> },
  log: Logger,
  now: () => Date = () => new Date(),
): Promise<CsmsUpdateCheckStartupOutcome> {
  try {
    if (!(await isCsmsUpdateCheckEnabled())) {
      log.debug('CSMS update check is off, nothing queued at start-up');
      return 'off';
    }
    const stored = await readCsmsUpdateCheck();
    if (
      stored != null &&
      now().getTime() - stored.attemptedAt.getTime() < UPDATE_CHECK_MIN_INTERVAL_MS
    ) {
      log.debug(
        { attemptedAt: stored.attemptedAt },
        'CSMS update check ran within the last day, nothing queued at start-up',
      );
      return 'not_due';
    }
    await cronQueue.add(
      'csms-update-check',
      {},
      { jobId: CSMS_UPDATE_CHECK_STARTUP_JOB_ID, removeOnComplete: true, removeOnFail: true },
    );
    log.info('CSMS update check queued at start-up');
    return 'queued';
  } catch (err) {
    log.warn({ err }, 'Could not queue the CSMS update check at start-up');
    return 'failed';
  }
}
