// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * What the OCPP 2.0.1 edge of the test station removed or changed from a
 * payload a test case built: one entry per path ("evse.connectorId removed",
 * "triggerReason RunningCost -> MeterValuePeriodic"). Values the edge adds
 * (required 2.0.1 fields filled with a default) are not losses.
 *
 * A 2.0.1 case that sets a field the 2.0.1 station cannot send would test the
 * CSMS with a message other than the one the case describes, so the executor
 * fails the case instead of passing it on a silently changed message.
 */
export function ocpp201MappingLosses(
  sent: Record<string, unknown>,
  wire: Record<string, unknown> | null,
): string[] {
  if (wire == null) return ['message not sent (nothing of it exists in OCPP 2.0.1)'];
  const losses: string[] = [];
  compare(sent, wire, '', losses);
  return losses;
}

function compare(sent: unknown, wire: unknown, path: string, losses: string[]): void {
  const at = path === '' ? 'payload' : path;
  if (Array.isArray(sent)) {
    if (!Array.isArray(wire)) {
      losses.push(`${at} changed`);
      return;
    }
    if (wire.length !== sent.length) {
      losses.push(
        `${at} ${String(sent.length - wire.length)} of ${String(sent.length)} items removed`,
      );
      return;
    }
    sent.forEach((item, i) => {
      compare(item, wire[i], `${path}[${String(i)}]`, losses);
    });
    return;
  }
  if (isRecord(sent)) {
    if (!isRecord(wire)) {
      losses.push(`${at} changed`);
      return;
    }
    for (const [key, value] of Object.entries(sent)) {
      if (value === undefined) continue;
      const child = path === '' ? key : `${path}.${key}`;
      if (!(key in wire)) {
        losses.push(`${child} removed`);
        continue;
      }
      compare(value, wire[key], child, losses);
    }
    return;
  }
  if (sent !== wire) losses.push(`${at} ${JSON.stringify(sent)} -> ${JSON.stringify(wire)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
