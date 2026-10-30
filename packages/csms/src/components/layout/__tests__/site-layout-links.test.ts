// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => false }));
import { loadLinks, type LinkPanel } from '../site-layout-links';
import { terminalSide, terminalsByStation } from '../layout-terminals';
import type { PaymentTerminal } from '@/components/payment-terminals/payment-terminal-types';

const circuit = (id: string, stations: string[]) => ({
  id,
  name: `Circuit ${id}`,
  breakerRatingAmps: 100,
  maxContinuousKw: 57.6,
  stations: stations.map((s) => ({ id: s, allocatedLimitKw: s === 'b' ? null : 22 })),
});

const panel = (
  id: string,
  circuits: ReturnType<typeof circuit>[],
  childPanels: LinkPanel[] = [],
) => ({
  id,
  name: `Panel ${id}`,
  breakerRatingAmps: 400,
  maxContinuousKw: 230.4,
  circuits,
  childPanels,
});

const stations = new Map([
  ['a', { x: 1.6, z: 0.9 }],
  ['b', { x: 4.8, z: 0.9 }],
  ['c', { x: 30, z: 12.5 }],
]);

describe('load management links', () => {
  it('runs from the transformer to each panel, its circuits and each managed station', () => {
    const links = loadLinks(
      [panel('p', [circuit('1', ['a', 'b'])])],
      [{ x: 36, z: 2, ratedKva: null }],
      stations,
    );
    expect(links.segments.map((s) => s.id)).toEqual([
      'panel:p',
      'circuit:1',
      'station:a',
      'station:b',
    ]);
    expect(links.segments[0]?.from).toEqual({ x: 36, z: 2 });
    expect(links.segments[2]?.to).toEqual({ x: 1.6, z: 0.9 });
    // A station without an allocated limit gets a link but no label.
    expect(links.labels.map((l) => l.id)).toEqual(['panel:p', 'circuit:1', 'station:a']);
    expect(links.labels[0]).toMatchObject({ name: 'Panel p', amps: 400, kw: 230.4 });
    expect(links.labels[2]).toMatchObject({ kind: 'station', kw: 22, name: null });
  });

  it('feeds each panel from the nearest transformer and walks child panels', () => {
    const links = loadLinks(
      [panel('p', [circuit('1', ['a'])], [panel('q', [circuit('2', ['c'])])])],
      [
        { x: -5, z: 0, ratedKva: null },
        { x: 60, z: 30, ratedKva: null },
      ],
      stations,
    );
    expect(links.segments[0]?.from).toEqual({ x: -5, z: 0 });
    expect(links.segments.map((s) => s.id)).toContain('panel:q');
    expect(links.segments.map((s) => s.id)).toContain('station:c');
  });

  it('feeds the panels from the largest transformer, not a nearer small one', () => {
    const links = loadLinks(
      [panel('p', [circuit('1', ['a'])])],
      [
        { x: 2, z: -6, ratedKva: 750 },
        { x: 36, z: 2, ratedKva: 2500 },
      ],
      stations,
    );
    expect(links.segments[0]?.from).toEqual({ x: 36, z: 2 });
  });

  it('leaves out panels and circuits without a station on the lot, and draws nothing without a transformer', () => {
    expect(
      loadLinks([panel('p', [circuit('1', ['zz'])])], [{ x: 0, z: 0, ratedKva: null }], stations),
    ).toEqual({
      segments: [],
      labels: [],
    });
    expect(loadLinks([panel('p', [circuit('1', ['a'])])], [], stations).segments).toEqual([]);
  });
});

describe('layout payment terminals', () => {
  const terminal = (overrides: Partial<PaymentTerminal>): PaymentTerminal =>
    ({
      id: 'pt_1',
      label: 'Reader',
      provider: 'idtech',
      serialNumber: 'SN1',
      providerDeviceId: null,
      stationId: 'sta_1',
      evseNumber: 1,
      status: 'active',
      online: true,
      hasDisplay: true,
      ...overrides,
    }) as PaymentTerminal;

  it('shows active paired terminals on their station, never inactive or unpaired ones', () => {
    const map = terminalsByStation([
      terminal({}),
      terminal({ id: 'pt_2', status: 'inactive' }),
      terminal({ id: 'pt_3', stationId: null }),
      terminal({ id: 'pt_4', label: null, evseNumber: null, hasDisplay: false, online: false }),
    ]);
    expect(map.get('sta_1')?.map((t) => t.id)).toEqual(['pt_1', 'pt_4']);
    expect(map.get('sta_1')?.[1]).toMatchObject({ name: 'SN1', hasDisplay: false, online: false });
  });

  it('puts a reader on its connector side, or in front for the whole station', () => {
    expect(terminalSide(1)).toBe(-1);
    expect(terminalSide(2)).toBe(1);
    expect(terminalSide(null)).toBe(0);
    expect(terminalSide(3)).toBe(0);
  });
});
