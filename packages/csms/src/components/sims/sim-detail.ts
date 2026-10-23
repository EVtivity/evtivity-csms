// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ParseKeys } from 'i18next';
import type {
  SimAttachmentSource,
  SimCapabilities,
  SimStoredStatus,
} from '@/components/sim/sim-connectivity';
import { simKey } from '@/components/sim/sim-connectivity';

interface UserRef {
  id: string;
  name: string | null;
}

/** The open attachment of `GET /v1/sims/:id`. */
export interface SimOpenAttachment {
  id: number;
  stationId: string | null;
  stationOcppId: string | null;
  siteId: string | null;
  siteName: string | null;
  paymentTerminalId: string | null;
  source: SimAttachmentSource;
  attachedAt: string;
  confirmed: boolean;
  confirmedAt: string | null;
}

/** `GET /v1/sims/:id`: the SIM, its open attachment and what the last Refresh stored. */
export interface SimDetailData {
  id: string;
  iccid: string;
  imsi: string | null;
  label: string | null;
  notes: string | null;
  provider: string | null;
  providerRef: string | null;
  /** The CSMS status, set by Deactivate and Reactivate only. */
  status: 'active' | 'inactive';
  deactivatedAt: string | null;
  deactivatedByUser: UserRef | null;
  /** The provider status stored by the last Refresh. */
  lastStatus: SimStoredStatus | null;
  statusFetchedAt: string | null;
  lastFetchedAt: string | null;
  lookupMissedAt: string | null;
  lookupMissReason: string | null;
  createdAt: string;
  updatedAt: string;
  attachment: SimOpenAttachment | null;
  attachedBy: UserRef | null;
  capabilities: SimCapabilities | null;
  network: {
    name: string | null;
    radioAccessTechnology: string | null;
    cellId: string | null;
    observedAt: string;
  } | null;
  recentAlerts: Array<{ kind: string; receivedAt: string }>;
  historyDays: number | null;
  reportingDelayHours: number | null;
  fetchDays: number;
  retentionDays: number;
  coverageTimeZone: string;
}

/** One row of `GET /v1/sims/:id/attachments`. */
export interface SimAttachmentItem {
  id: number;
  stationId: string | null;
  stationOcppId: string | null;
  siteId: string | null;
  siteName: string | null;
  paymentTerminalId: string | null;
  source: string;
  attachedAt: string;
  attachedBy: UserRef | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  detachedAt: string | null;
  detachedBy: string | null;
  detachReason: string | null;
}

/** Query key of the SIM itself; the timeline and attachments sit next to it under `simKey`. */
export function simDetailKey(simId: string): readonly unknown[] {
  return [...simKey(simId), 'detail'];
}

const SOURCE_KEYS: Record<SimAttachmentSource, ParseKeys> = {
  reported: 'sims.detail.attachments.sourceLabel.reported',
  entered: 'sims.detail.attachments.sourceLabel.entered',
  attached: 'sims.detail.attachments.sourceLabel.attached',
  imported: 'sims.detail.attachments.sourceLabel.imported',
};

/** Where an attachment came from, in plain words; an unknown source shows as it came. */
export function attachmentSourceKey(source: string): ParseKeys | null {
  return source in SOURCE_KEYS ? SOURCE_KEYS[source as SimAttachmentSource] : null;
}

const REASON_KEYS: Record<string, ParseKeys> = {
  detached: 'sims.detail.attachments.reason.detached',
  iccid_changed: 'sims.detail.attachments.reason.iccidChanged',
  replaced: 'sims.detail.attachments.reason.replaced',
  displaced: 'sims.detail.attachments.reason.displaced',
  deactivated: 'sims.detail.attachments.reason.deactivated',
};

/** Why an attachment was closed, in plain words; an unknown reason shows as it came. */
export function detachReasonKey(reason: string): ParseKeys | null {
  return REASON_KEYS[reason] ?? null;
}
