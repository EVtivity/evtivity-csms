// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { SecurityProfileBadge } from '../SecurityProfileBadge';

describe('SecurityProfileBadge', () => {
  it.each([
    [0, 'bg-destructive'],
    [1, 'bg-warning'],
    [2, 'bg-info'],
    [3, 'bg-success'],
  ])('renders profile %i on the severity ramp', (profile, expectedClass) => {
    const { container } = render(<SecurityProfileBadge profile={profile} />);
    expect(container.firstElementChild?.className).toContain(expectedClass);
  });

  it.each([
    [0, 'stations.sp0'],
    [1, 'stations.sp1'],
    [2, 'stations.sp2'],
    [3, 'stations.sp3'],
  ])('labels OCPP 2.1 profile %i with %s', (profile, key) => {
    const { container } = render(<SecurityProfileBadge profile={profile} />);
    expect(container.textContent).toBe(key);
  });

  it.each([
    [0, 'stations.sp16_0'],
    [1, 'stations.sp16_1'],
    [2, 'stations.sp16_2'],
  ])('labels OCPP 1.6 profile %i with %s', (profile, key) => {
    const { container } = render(<SecurityProfileBadge profile={profile} ocppProtocol="ocpp1.6" />);
    expect(container.textContent).toBe(key);
  });

  it('falls back to the Basic Auth label and warning variant for unknown profiles', () => {
    const { container } = render(<SecurityProfileBadge profile={9} />);
    expect(container.textContent).toBe('stations.sp1');
    expect(container.firstElementChild?.className).toContain('bg-warning');
  });
});
