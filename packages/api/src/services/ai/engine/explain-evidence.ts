// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Where an Explain conversation gets its evidence pack and the record's
 * latest insight, from
 * the insights backend: the evidence collectors of
 * `@evtivity/services/ai-evidence` and the insight service.
 *
 * - `collectEvidence` returns the same whitelisted pack insights use (facts,
 *   items, and the station-supplied strings kept apart; `explain-engine.ts`
 *   keeps the curated part), read for the
 *   subject's own station, session, token refusals or reservation only, so it holds no
 *   other site's data. The caller redacts it (support level), frames it as
 *   untrusted and caps its size.
 * - `latestInsight` returns the subject's newest `active` insight that is not
 *   stale, with its text in `language` when that translation is ready, else
 *   the canonical text. It never triggers a model call (no translation job
 *   either): Explain spends no tokens on the insight.
 * - A throw is caught by the caller (logged at warn, the turn goes on without
 *   that part).
 */

import type { AiInsightDto } from '@evtivity/lib/ai-insights';
import {
  collectAttemptAuthorizationEvidence,
  collectReservationEvidence,
  collectSessionEvidence,
  collectStationEvidence,
} from '@evtivity/services/ai-evidence';
import type { EvidencePack } from '@evtivity/services/ai-evidence';
import { latestActiveInsight } from '@evtivity/services/ai-insight.service';
import { config } from '../../../lib/config.js';
import type { ExplainSubject } from './explain-context.js';
import type { ExplainEvidence } from './explain-engine.js';

export interface ExplainEvidenceSource {
  collectEvidence: (subject: ExplainSubject) => Promise<ExplainEvidence | null>;
  latestInsight: (subject: ExplainSubject, language: string) => Promise<AiInsightDto | null>;
}

async function subjectPack(subject: ExplainSubject): Promise<EvidencePack | null> {
  if (subject.kind === 'station') {
    if (subject.stationId == null) return null;
    return (await collectStationEvidence(subject.stationId))?.pack ?? null;
  }
  if (subject.kind === 'session') {
    if (subject.sessionId == null) return null;
    return (await collectSessionEvidence(subject.sessionId))?.pack ?? null;
  }
  if (subject.kind === 'reservation') {
    if (subject.reservationId == null) return null;
    return (
      (await collectReservationEvidence(subject.reservationId, config.SETTINGS_ENCRYPTION_KEY))
        ?.pack ?? null
    );
  }
  if (subject.authorizeAttemptId == null || subject.stationId == null) return null;
  return (
    (
      await collectAttemptAuthorizationEvidence(
        subject.authorizeAttemptId,
        subject.stationId,
        `authorization:${subject.id}`,
      )
    )?.pack ?? null
  );
}

export const explainEvidenceSource: ExplainEvidenceSource = {
  async collectEvidence(subject) {
    const pack = await subjectPack(subject);
    // The record moved to another site since the access check: no evidence.
    if (pack == null || pack.subject.siteId !== subject.siteId) return null;
    return { facts: pack.facts, items: pack.items, untrusted: pack.untrusted };
  },
  latestInsight: (subject, language) =>
    latestActiveInsight(
      {
        kind: subject.kind,
        stationId: subject.stationId,
        sessionId: subject.sessionId,
        authorizeAttemptId: subject.authorizeAttemptId,
        reservationId: subject.reservationId,
      },
      language,
    ),
};
