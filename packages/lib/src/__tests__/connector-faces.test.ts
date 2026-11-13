// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  CONNECTOR_FACES,
  connectorKindOf,
  faceDrawing,
  knownConnectorKind,
} from '../connector-faces.js';

describe('connector faces', () => {
  it.each([
    ['cType1', 'type1'],
    ['J1772', 'type1'],
    ['cType2', 'type2'],
    ['sType2', 'type2'],
    ['cCCS1', 'ccs1'],
    ['CCS2', 'ccs2'],
    ['cG105', 'chademo'],
    ['CHAdeMO', 'chademo'],
    ['cTesla', 'nacs'],
    ['J3400', 'nacs'],
    ['cMCS', 'mcs'],
  ] as const)('names %s as %s', (type, kind) => {
    expect(knownConnectorKind(type)).toBe(kind);
    expect(connectorKindOf(type, false)).toBe(kind);
  });

  it('names no kind for an unknown or missing type, and the charging kind picks the default', () => {
    expect(knownConnectorKind('Other1PhMax16A')).toBeNull();
    expect(knownConnectorKind(null)).toBeNull();
    expect(knownConnectorKind('constructor')).toBeNull();
    expect(knownConnectorKind('toString')).toBeNull();
    expect(connectorKindOf(null, true)).toBe('ccs1');
    expect(connectorKindOf('Unknown', false)).toBe('type1');
  });

  it('draws every face with its outline and power contacts', () => {
    for (const face of Object.values(CONNECTOR_FACES)) {
      const d = faceDrawing(face, 48);
      expect(d.outline.startsWith('M')).toBe(true);
      expect(d.contacts.length).toBeGreaterThan(0);
    }
  });
});
