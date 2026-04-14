// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'info';

/** Reservation status -> badge variant (active/scheduled/in_use/used/cancelled/expired) */
export function reservationStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'active':
      return 'default';
    case 'scheduled':
      return 'info';
    case 'in_use':
      return 'success';
    case 'used':
      return 'secondary';
    case 'cancelled':
      return 'destructive';
    case 'expired':
      return 'outline';
    default:
      return 'outline';
  }
}

/** Fleet reservation status -> badge variant (active/partial/cancelled/expired/completed) */
export function fleetReservationStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'active':
      return 'success';
    case 'partial':
      return 'warning';
    case 'cancelled':
      return 'destructive';
    case 'expired':
      return 'outline';
    case 'completed':
      return 'secondary';
    default:
      return 'outline';
  }
}

/** Session status -> badge variant. Handles idling override for active sessions. */
export function sessionStatusVariant(status: string, isIdling = false): BadgeVariant {
  if (status === 'active' && isIdling) return 'warning';
  switch (status) {
    case 'active':
      return 'success';
    case 'completed':
      return 'secondary';
    case 'faulted':
      return 'destructive';
    default:
      return 'outline';
  }
}

/** Simple session status -> badge variant (no idling, used in reservation session tab) */
export function simpleSessionStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'active':
      return 'success';
    case 'completed':
      return 'secondary';
    case 'failed':
      return 'destructive';
    case 'pending':
      return 'warning';
    default:
      return 'outline';
  }
}

/** OCPI roaming session status -> badge variant (ACTIVE/COMPLETED/INVALID) */
export function roamingSessionStatusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'ACTIVE':
      return 'default';
    case 'COMPLETED':
      return 'secondary';
    case 'INVALID':
      return 'destructive';
    default:
      return 'outline';
  }
}

/** Payment status -> badge variant */
export function paymentStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'captured':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'pre_authorized':
    case 'pending':
      return 'warning';
    case 'cancelled':
      return 'secondary';
    case 'refunded':
    case 'partially_refunded':
      return 'outline';
    default:
      return 'outline';
  }
}

/** Transaction event type -> badge variant (started/ended/updated) */
export function eventTypeVariant(
  type: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (type) {
    case 'started':
      return 'default';
    case 'ended':
      return 'secondary';
    case 'updated':
      return 'outline';
    default:
      return 'outline';
  }
}

/** Support case status -> badge variant */
export function supportCaseStatusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'open':
      return 'default';
    case 'in_progress':
      return 'secondary';
    case 'waiting_on_driver':
      return 'outline';
    case 'resolved':
      return 'secondary';
    case 'closed':
      return 'outline';
    default:
      return 'outline';
  }
}

/** Support case priority -> badge variant */
export function supportCasePriorityVariant(
  priority: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (priority) {
    case 'urgent':
      return 'destructive';
    case 'high':
      return 'destructive';
    case 'medium':
      return 'default';
    case 'low':
      return 'outline';
    default:
      return 'outline';
  }
}

/** OCPI roaming partner status -> badge variant */
export function roamingPartnerStatusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'connected':
      return 'default';
    case 'pending':
      return 'secondary';
    case 'suspended':
      return 'outline';
    case 'disconnected':
      return 'destructive';
    default:
      return 'outline';
  }
}

/** Station status -> badge variant (for station list/card displays) */
export function stationStatusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'available':
      return 'default';
    case 'charging':
      return 'secondary';
    case 'reserved':
      return 'outline';
    case 'faulted':
      return 'destructive';
    case 'unavailable':
      return 'secondary';
    default:
      return 'outline';
  }
}

/** Station card connector status -> badge variant (simplified, for load management card) */
export function stationCardConnectorStatusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'available':
      return 'default';
    case 'occupied':
      return 'secondary';
    case 'faulted':
      return 'destructive';
    default:
      return 'outline';
  }
}

/** Connector status -> badge variant (for ConnectorStatus chart) */
export function connectorStatusVariant(
  status: string,
  isIdling?: boolean,
): 'secondary' | 'warning' {
  if (status === 'occupied' && isIdling === true) return 'warning';
  return 'secondary';
}

/** HTTP method -> badge variant (for access logs) */
export function httpMethodVariant(
  method: string,
): 'default' | 'success' | 'warning' | 'destructive' | 'secondary' {
  switch (method) {
    case 'GET':
      return 'default';
    case 'POST':
      return 'success';
    case 'PATCH':
    case 'PUT':
      return 'warning';
    case 'DELETE':
      return 'destructive';
    default:
      return 'secondary';
  }
}

/** HTTP status code -> badge variant (for access logs) */
export function httpStatusVariant(
  code: number,
): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (code >= 200 && code < 300) return 'success';
  if (code >= 400 && code < 500) return 'warning';
  if (code >= 500) return 'destructive';
  return 'secondary';
}

/** Worker job status -> badge variant (for worker logs) */
export function workerStatusVariant(
  status: string,
): 'success' | 'destructive' | 'warning' | 'secondary' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'started':
      return 'warning';
    default:
      return 'secondary';
  }
}

/** Certificate status -> badge variant (for CSR requests, station/CA certificates) */
export function certificateStatusVariant(
  status: string,
): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'expired' || status === 'rejected') return 'destructive';
  if (status === 'pending' || status === 'submitted') return 'secondary';
  return 'outline';
}

/** Station certificate status -> badge variant (simplified, for station detail cert tab) */
export function stationCertificateStatusVariant(
  status: string,
): 'default' | 'destructive' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'expired') return 'destructive';
  return 'outline';
}

/** Report status -> badge variant (for report history) */
export function reportStatusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'completed':
      return 'default';
    case 'pending':
    case 'generating':
      return 'secondary';
    case 'failed':
      return 'destructive';
    default:
      return 'outline';
  }
}

/** CDR push status -> badge variant (for OCPI CDRs) */
export function cdrPushStatusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'confirmed':
      return 'default';
    case 'sent':
      return 'secondary';
    case 'pending':
      return 'outline';
    case 'failed':
      return 'destructive';
    default:
      return 'outline';
  }
}

/** Notification delivery status -> badge className (for notification log tabs) */
export function notificationStatusBadgeClass(status: string): string {
  switch (status) {
    case 'sent':
      return 'bg-success text-success-foreground hover:bg-success/80';
    case 'failed':
      return 'bg-destructive text-destructive-foreground hover:bg-destructive/80';
    case 'pending':
      return 'bg-warning text-warning-foreground hover:bg-warning/80';
    default:
      return '';
  }
}
