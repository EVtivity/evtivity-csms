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
  metadata?: { failureReason?: string } | null;
}

export const statusBadgeClass = notificationStatusBadgeClass;

export function formatTimestamp(sentAt: string | null, createdAt: string): string {
  return sentAt != null ? new Date(sentAt).toLocaleString() : new Date(createdAt).toLocaleString();
}

/** Render the recipient column. Empty strings come from dispatch attempts
 * where no address was on file (the failureReason carries that signal). */
export function formatRecipient(recipient: string): string {
  return recipient === '' ? '—' : recipient;
}

/** Map the dispatcher's failureReason enum to short, operator-friendly text.
 * Unknown reasons fall through as-is so a future reason added to the dispatcher
 * still surfaces something rather than nothing. */
export function formatFailureReason(reason: string | undefined | null): string | null {
  if (reason == null || reason === '') return null;
  switch (reason) {
    case 'recipient_missing':
      return 'No address on file';
    case 'smtp_not_configured':
      return 'SMTP not configured';
    case 'twilio_not_configured':
      return 'Twilio not configured';
    case 'credentials_decrypt_failed':
      return 'Credentials decrypt failed';
    case 'smtp_send_failed':
      return 'SMTP send failed';
    case 'twilio_send_failed':
      return 'Twilio send failed';
    case 'webhook_send_failed':
      return 'Webhook delivery failed';
    case 'webhook_blocked_private_url':
      return 'Webhook blocked (private URL)';
    case 'webhook_http_error':
      return 'Webhook returned non-2xx';
    case 'webhook_network_error':
      return 'Webhook network error';
    case 'webhook_timeout':
      return 'Webhook timed out';
    default:
      return reason;
  }
}
