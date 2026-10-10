// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Auto-dismiss times for the CSMS and portal toasts. Every toast dismisses
// itself: call sites never set a duration. A message that must stay on screen
// belongs inline in the page or in a dialog, not in a toast.

export type ToastVariantName = 'default' | 'success' | 'info' | 'warning' | 'destructive';

export const TOAST_DURATIONS_MS: Readonly<Record<ToastVariantName, number>> = {
  default: 5_000,
  success: 5_000,
  info: 5_000,
  warning: 7_000,
  destructive: 10_000,
};

// A toast with an action button stays longer so the user can reach the action.
export const TOAST_ACTION_DURATION_MS = 15_000;

export function toastDurationMs(variant: ToastVariantName, hasAction: boolean): number {
  const base = TOAST_DURATIONS_MS[variant];
  return hasAction ? Math.max(base, TOAST_ACTION_DURATION_MS) : base;
}
