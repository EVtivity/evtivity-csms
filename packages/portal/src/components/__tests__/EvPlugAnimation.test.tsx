// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` }),
}));

import { EvPlugAnimation } from '../EvPlugAnimation';

function mockReducedMotion(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduced && query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EvPlugAnimation', () => {
  it.each([
    ['Type2', 'type2'],
    ['cType1', 'type1'],
    ['CCS1', 'ccs1'],
    ['cCCS2', 'ccs2'],
    ['CHAdeMO', 'chademo'],
    ['NACS', 'nacs'],
  ])('draws the inlet face of a %s connector', (type, kind) => {
    mockReducedMotion(false);
    render(<EvPlugAnimation connectorType={type} />);
    expect(screen.getByTestId('ev-plug-face').getAttribute('data-connector')).toBe(kind);
  });

  it.each([[null], ['Other1PhMax16A'], [undefined]])(
    'falls back to a neutral round inlet for %s',
    (type) => {
      mockReducedMotion(false);
      render(<EvPlugAnimation connectorType={type} />);
      expect(screen.getByTestId('ev-plug-face').getAttribute('data-connector')).toBe('neutral');
    },
  );

  it('is an image with a translated label', () => {
    mockReducedMotion(false);
    render(<EvPlugAnimation connectorType="Type2" />);
    const img = screen.getByRole('img', { name: 't:charger.plugInAnimationLabel' });
    expect(img.getAttribute('data-motion')).toBe('loop');
    expect(screen.getByTestId('ev-plug-handle').getAttribute('class')).toBe('ev-plug-handle');
  });

  it('shows the still frame, plugged in with the light on, under reduced motion', () => {
    mockReducedMotion(true);
    render(<EvPlugAnimation connectorType="CCS2" />);
    expect(screen.getByTestId('ev-plug-animation').getAttribute('data-motion')).toBe('still');
    expect(screen.getByTestId('ev-plug-handle').getAttribute('class')).toBeNull();
    const light = screen.getByTestId('ev-plug-light');
    expect(light.getAttribute('class')).toBeNull();
    expect(light.getAttribute('opacity')).toBe('1');
  });
});
