// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { StationStatusBadge } from '../StationStatusBadge';

describe('StationStatusBadge', () => {
  it('shows the status label', () => {
    render(<StationStatusBadge status="charging" statusReason={null} />);
    expect(screen.getByText('status.charging')).toBeDefined();
  });

  it('explains why a station is unavailable on hover', () => {
    render(<StationStatusBadge status="unavailable" statusReason="operator_disabled" />);
    fireEvent.mouseEnter(screen.getByText('status.unavailable'));
    expect(screen.getByText('stations.statusReason.operator_disabled')).toBeDefined();
  });

  it('has no reason tooltip when the station is available', () => {
    render(<StationStatusBadge status="available" statusReason="connector_faulted" />);
    fireEvent.mouseEnter(screen.getByText('status.available'));
    expect(screen.queryByText('stations.statusReason.connector_faulted')).toBeNull();
  });
});
