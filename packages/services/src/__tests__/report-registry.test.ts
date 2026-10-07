// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { ReportGeneratorRegistry } from '../report-registry.js';
import type { ReportGeneratorDescriptor } from '../report-registry.js';

function descriptor(
  type: string,
  overrides: Partial<ReportGeneratorDescriptor> = {},
): ReportGeneratorDescriptor {
  return {
    type,
    generate: vi.fn(),
    formats: ['csv', 'pdf', 'xlsx'],
    generateFromUi: true,
    ...overrides,
  };
}

describe('ReportGeneratorRegistry', () => {
  it('returns a registered descriptor by type and lists them in registration order', () => {
    const registry = new ReportGeneratorRegistry();
    const a = descriptor('a');
    const b = descriptor('b', { formats: ['xlsx'], generateFromUi: false });
    registry.register(a);
    registry.register(b);

    expect(registry.get('a')).toBe(a);
    expect(registry.get('b')).toBe(b);
    expect(registry.get('c')).toBeUndefined();
    expect(registry.list()).toEqual([a, b]);
  });

  it('throws when a type is registered twice', () => {
    const registry = new ReportGeneratorRegistry();
    registry.register(descriptor('a'));
    expect(() => {
      registry.register(descriptor('a'));
    }).toThrow('Report generator a is already registered');
  });

  it('throws when a descriptor has no format', () => {
    const registry = new ReportGeneratorRegistry();
    expect(() => {
      registry.register(descriptor('a', { formats: [] }));
    }).toThrow('Report generator a has no format');
  });
});
