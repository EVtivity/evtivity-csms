// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CONNECTOR_ICONS } from '../connector-icon-of';
import {
  POWER_TO_SIGNAL,
  distanceToOutline,
  faceDrawing,
  faceTransform,
  type ConnectorIconSize,
  type FaceGeometry,
} from '../connector-face';
import { CONNECTOR_KIND_NAMES } from '../connector-kind-name';
import { TYPE1_FACE } from '../Type1Icon';
import { TYPE2_FACE } from '../Type2Icon';
import { CCS1_FACE } from '../Ccs1Icon';
import { CCS2_FACE } from '../Ccs2Icon';
import { CHADEMO_FACE } from '../ChademoIcon';
import { NACS_FACE } from '../NacsIcon';
import { MCS_FACE } from '../McsIcon';
import { CONNECTOR_SPECS, type ConnectorKind } from '../../layout/site-layout-connectors';
import { ConnectorTypeIcon } from '../../ConnectorTypeIcon';
import { statusIconColor } from '@/lib/chart-theme';

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

const FACES: Record<ConnectorKind, FaceGeometry> = {
  type1: TYPE1_FACE,
  type2: TYPE2_FACE,
  ccs1: CCS1_FACE,
  ccs2: CCS2_FACE,
  chademo: CHADEMO_FACE,
  nacs: NACS_FACE,
  mcs: MCS_FACE,
};
const KINDS = Object.keys(FACES) as ConnectorKind[];
const SIZES = [16, 20, 24, 48] as const;

function drawn(kind: ConnectorKind, size: ConnectorIconSize): SVGElement {
  cleanup();
  const Icon = CONNECTOR_ICONS[kind];
  render(<Icon label={kind} size={size} />);
  return screen.getByRole('img', { name: kind }) as unknown as SVGElement;
}

const num = (el: Element, attr: string): number => Number(el.getAttribute(attr));

describe('connector face pictograms', () => {
  it('has one pictogram per connector type, MCS included', () => {
    expect(Object.keys(CONNECTOR_ICONS).sort()).toEqual([...KINDS].sort());
  });

  it('takes the Type 1 and CCS1 contact centers from CONNECTOR_SPECS (one geometry source)', () => {
    const mm = (c: { x: number; y: number }) => ({ x: c.x * 1000, y: -c.y * 1000 });
    const j1772 = CONNECTOR_SPECS.type1.contacts.map(mm);
    const type1 = TYPE1_FACE.contacts.map((c) => ({ x: c.x, y: c.y }));
    type1.forEach((c, i) => {
      expect(c.x).toBeCloseTo(j1772[i]?.x ?? NaN, 2);
      expect(c.y).toBeCloseTo(j1772[i]?.y ?? NaN, 2);
    });
    const ccs = CONNECTOR_SPECS.ccs1.contacts.map(mm);
    const byName = new Map(CCS1_FACE.contacts.map((c) => [c.name, c]));
    for (const [name, spec] of [
      ['L1', j1772[0]],
      ['N', j1772[1]],
      ['PE', ccs[0]],
      ['PP', ccs[1]],
      ['CP', ccs[2]],
      ['DC+', ccs[3]],
      ['DC-', ccs[4]],
    ] as const) {
      expect(byName.get(name)?.x, name).toBeCloseTo(spec?.x ?? NaN, 2);
      expect(byName.get(name)?.y, name).toBeCloseTo(spec?.y ?? NaN, 2);
    }
    // The cited J1772 numbers: DC pins 26 mm apart 42 mm below, PE 10.8 mm below.
    expect(byName.get('DC-')?.x).toBeCloseTo(13, 2);
    expect(byName.get('DC-')?.y).toBeCloseTo(42, 2);
    expect(byName.get('PE')?.y).toBeCloseTo(10.8, 2);
  });

  it('draws every contact at its measured center, within 2 percent (48 px)', () => {
    const tolerance = 0.02 * 16;
    for (const kind of KINDS) {
      const face = FACES[kind];
      const t = faceTransform(face);
      const svg = drawn(kind, 48);
      for (const c of face.contacts) {
        const el = svg.querySelector(`[data-contact="${c.name}"]`);
        // Every power and earth contact shows at 48 px.
        if (c.role !== 'signal') expect(el, `${kind} ${c.name}`).not.toBeNull();
        if (el == null) continue;
        expect(Math.abs(num(el, 'cx') - t.x(c.x)), `${kind} ${c.name} x`).toBeLessThan(tolerance);
        expect(Math.abs(num(el, 'cy') - t.y(c.y)), `${kind} ${c.name} y`).toBeLessThan(tolerance);
      }
    }
  });

  it('draws no contact larger than measured, power and earth at least 1.6 times the signals', () => {
    for (const kind of KINDS) {
      const face = FACES[kind];
      const t = faceTransform(face);
      const byName = new Map(face.contacts.map((c) => [c.name, c]));
      for (const size of [24, 48] as const) {
        const d = faceDrawing(face, size);
        const power = d.contacts.filter((c) => byName.get(c.name)?.role !== 'signal');
        const smallest = Math.min(...power.map((c) => c.edge));
        for (const c of d.contacts) {
          const measured = ((byName.get(c.name)?.d ?? 0) / 2) * t.scale;
          expect(c.edge, `${kind} ${c.name}`).toBeLessThanOrEqual(measured + 1e-9);
          if (byName.get(c.name)?.role === 'signal') {
            expect(c.edge, `${kind} ${c.name}`).toBeLessThanOrEqual(
              smallest / POWER_TO_SIGNAL + 1e-9,
            );
          }
        }
      }
    }
  });

  it('keeps one stroke width (and 1 device px) clear between every two strokes at every size', () => {
    for (const kind of KINDS) {
      for (const size of SIZES) {
        const d = faceDrawing(FACES[kind], size);
        const label = `${kind} ${String(size)} px`;
        expect(d.gap, label).toBeGreaterThanOrEqual(Math.max(d.contactStroke, 16 / size) - 1e-9);
        // The outline reads heavier than the contacts.
        expect(d.stroke, label).toBeGreaterThan(d.contactStroke);
        for (let i = 0; i < d.contacts.length; i++) {
          const a = d.contacts[i];
          if (a == null) continue;
          const toOutline = distanceToOutline(a.cx, a.cy, d.outlinePoints) - d.stroke / 2 - a.edge;
          expect(toOutline, `${label} ${a.name} to the outline`).toBeGreaterThanOrEqual(
            d.gap - 1e-6,
          );
          for (let j = i + 1; j < d.contacts.length; j++) {
            const b = d.contacts[j];
            if (b == null) continue;
            const gap = Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.edge - b.edge;
            expect(gap, `${label} ${a.name} to ${b.name}`).toBeGreaterThanOrEqual(d.gap - 1e-6);
          }
        }
      }
    }
  });

  it('shows only the power and earth contacts, as solid dots, at 16 and 20 px', () => {
    for (const kind of KINDS) {
      for (const size of [16, 20] as const) {
        const svg = drawn(kind, size);
        const shown = [...svg.querySelectorAll('circle')].map((c) =>
          c.getAttribute('data-contact'),
        );
        const expected = FACES[kind].contacts.filter((c) => c.role !== 'signal').map((c) => c.name);
        expect(shown, `${kind} ${String(size)}`).toEqual(expected);
        for (const c of svg.querySelectorAll('circle'))
          expect(c.getAttribute('fill')).not.toBe('none');
      }
    }
  });

  it('uses a heavier line in view units at small sizes, never thinner in px as it grows', () => {
    const units = SIZES.map((size) =>
      num(drawn('nacs', size).querySelector('path') as Element, 'stroke-width'),
    );
    for (let i = 1; i < units.length; i++) expect(units[i]).toBeLessThan(units[i - 1] ?? 0);
    const px = SIZES.map((size, i) => ((units[i] ?? 0) * size) / 16);
    for (let i = 1; i < px.length; i++) expect(px[i]).toBeGreaterThanOrEqual(px[i - 1] ?? 0);
  });

  it('draws the MCS and NACS outlines without sharp corners', () => {
    for (const kind of ['mcs', 'nacs'] as const) {
      const pts = FACES[kind].outline;
      let sharpest = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i + pts.length - 1) % pts.length];
        const b = pts[i];
        const c = pts[(i + 1) % pts.length];
        if (a == null || b == null || c == null) continue;
        const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
        const turn = Math.abs(Math.atan2(Math.sin(t2 - t1), Math.cos(t2 - t1)));
        sharpest = Math.max(sharpest, turn);
      }
      // No turn sharper than 10 degrees between two outline segments.
      expect(sharpest, kind).toBeLessThan((10 * Math.PI) / 180);
    }
  });

  it('strokes the outline in the status color and leaves the inside open', () => {
    render(
      <ConnectorTypeIcon
        type="CCS1"
        status="charging"
        dc
        size={24}
        label="EVSE 1, CCS1, Charging"
      />,
    );
    const icon = screen.getByRole('img', { name: 'EVSE 1, CCS1, Charging' });
    expect(icon.getAttribute('data-connector')).toBe('ccs1');
    expect(icon.querySelector('title')?.textContent).toBe('EVSE 1, CCS1, Charging');
    const outline = icon.querySelector('path');
    expect(outline?.getAttribute('stroke')).toBe(statusIconColor('charging', false));
    expect(outline?.getAttribute('fill')).toBe('none');
    for (const c of icon.querySelectorAll('circle')) {
      expect(c.getAttribute('stroke') ?? c.getAttribute('fill')).toBe(
        statusIconColor('charging', false),
      );
    }
  });

  it('uses the dark theme status colors on a dark page', () => {
    document.documentElement.classList.add('dark');
    render(<ConnectorTypeIcon type="Type2" status="preparing" dc={false} label="Type 2" />);
    const icon = screen.getByRole('img', { name: 'Type 2' });
    expect(icon.querySelector('path')?.getAttribute('stroke')).toBe(
      statusIconColor('preparing', true),
    );
  });

  it('names every kind by its standard name', () => {
    expect(KINDS.map((k) => CONNECTOR_KIND_NAMES[k]).sort()).toEqual([
      'CCS1',
      'CCS2',
      'CHAdeMO',
      'MCS',
      'NACS',
      'Type 1',
      'Type 2',
    ]);
  });
});
