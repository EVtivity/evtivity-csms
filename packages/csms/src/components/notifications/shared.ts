// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { notificationStatusBadgeClass } from '@/lib/status-variants';

export interface NotificationRecord {
  id: number;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  status: string;
  eventType: string | null;
  sentAt: string | null;
  createdAt: string;
}

export const statusBadgeClass = notificationStatusBadgeClass;

export function formatTimestamp(sentAt: string | null, createdAt: string): string {
  return sentAt != null ? new Date(sentAt).toLocaleString() : new Date(createdAt).toLocaleString();
}
