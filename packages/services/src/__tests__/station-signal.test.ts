// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { dataLinkGetVariables } from '../station-sim.service.js';
import { lowSignalThreshold } from '../station-signal-monitor.service.js';

const row = (component: string, instance: string | null, variable: string) => ({
  component,
  instance,
  variable,
});

describe('dataLinkGetVariables', () => {
  it('reads every reported DataLink variable, signal strengths first, then the network profile', () => {
    const items = dataLinkGetVariables(
      [
        row('DataLink', 'Modem1', 'Active'),
        row('DataLink', 'Modem1', 'NetworkAddress'),
        row('DataLink', 'Modem2', 'Fallback'),
        row('DataLink', 'Modem1', 'VendorThing'),
        row('OCPPCommCtrlr', null, 'ActiveNetworkProfile'),
      ],
      null,
    );
    expect(items).toEqual([
      { component: { name: 'DataLink', instance: 'Modem1' }, variable: { name: 'SignalStrength' } },
      { component: { name: 'DataLink', instance: 'Modem2' }, variable: { name: 'SignalStrength' } },
      { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'ActiveNetworkProfile' } },
      { component: { name: 'DataLink', instance: 'Modem1' }, variable: { name: 'Active' } },
      { component: { name: 'DataLink', instance: 'Modem1' }, variable: { name: 'NetworkAddress' } },
      { component: { name: 'DataLink', instance: 'Modem2' }, variable: { name: 'Fallback' } },
    ]);
  });

  it('keeps to the station ItemsPerMessage', () => {
    const items = dataLinkGetVariables(
      [row('DataLink', null, 'Active'), row('DataLink', null, 'ICCID')],
      2,
    );
    expect(items).toEqual([
      { component: { name: 'DataLink' }, variable: { name: 'SignalStrength' } },
      { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'ActiveNetworkProfile' } },
    ]);
  });

  it('keeps the whole message within the station BytesPerMessage, signal strength first', () => {
    const rows = [
      row('DataLink', 'Modem1', 'Active'),
      row('DataLink', 'Modem1', 'ICCID'),
      row('DataLink', 'Modem1', 'NetworkAddress'),
    ];
    // The OCPP-J CALL as sent: message type, a 36-character message id, action, payload.
    const frameBytes = (items: Array<Record<string, unknown>>): number =>
      Buffer.byteLength(
        JSON.stringify([2, 'x'.repeat(36), 'GetVariables', { getVariableData: items }]),
      );
    const all = dataLinkGetVariables(rows, null);
    const budget = frameBytes(all.slice(0, 2)) + 10;
    const items = dataLinkGetVariables(rows, null, budget);
    expect(items).toEqual(all.slice(0, 2));
    expect(frameBytes(items)).toBeLessThanOrEqual(budget);
    // Both limits apply; the signal strength is sent even when it alone is over.
    expect(dataLinkGetVariables(rows, 1, budget)).toEqual(all.slice(0, 1));
    expect(dataLinkGetVariables(rows, null, 10)).toEqual(all.slice(0, 1));
  });

  it('reads nothing without a DataLink, and never the payment terminal SIM', () => {
    expect(
      dataLinkGetVariables(
        [row('PaymentCtrlr', null, 'ICCID'), row('PaymentCtrlr', null, 'IMSI')],
        null,
      ),
    ).toEqual([]);
  });
});

describe('lowSignalThreshold', () => {
  it('keeps dBm for a dBm modem and when the unit is unknown', () => {
    expect(lowSignalThreshold(-100, { unit: 'dBm', value: '-70' })).toBe(-100);
    expect(lowSignalThreshold(-100, { unit: null, value: null })).toBe(-100);
    expect(lowSignalThreshold(-100, { unit: null, value: '-80' })).toBe(-100);
  });

  it('converts to ASU for a modem that reports ASU, by unit or by range', () => {
    expect(lowSignalThreshold(-101, { unit: 'ASU', value: '20' })).toBe(6);
    expect(lowSignalThreshold(-101, { unit: null, value: '18' })).toBe(6);
    expect(lowSignalThreshold(-140, { unit: 'asu', value: null })).toBe(0);
    expect(lowSignalThreshold(-40, { unit: 'ASU', value: null })).toBe(31);
  });
});
