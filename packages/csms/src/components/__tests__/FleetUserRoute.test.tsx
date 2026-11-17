// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const auth = vi.hoisted(() => ({ fleetUser: true }));
vi.mock('@/lib/auth', () => ({ useIsFleetUser: () => auth.fleetUser }));

import { FleetUserRoute, fleetUserPathAllowed } from '../FleetUserRoute';

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <FleetUserRoute>
              <p>page content</p>
            </FleetUserRoute>
          }
        />
        <Route path="/" element={<p>dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  auth.fleetUser = true;
});

describe('fleetUserPathAllowed', () => {
  it('allows the dashboard, the fleet pages, a fleet invoice, the profile and Settings', () => {
    for (const path of [
      '/',
      '/fleets',
      '/fleets/',
      '/fleets/flt_1',
      '/invoices/inv_1',
      '/profile',
      '/settings',
    ]) {
      expect(fleetUserPathAllowed(path), path).toBe(true);
    }
  });

  it('refuses every other page and the fleet write pages', () => {
    for (const path of [
      '/stations',
      '/sessions/ses_1',
      '/tokens',
      '/users',
      '/fleets/new',
      '/fleets/flt_1/drivers/add',
      '/invoices',
      '/settings/ocpp',
    ]) {
      expect(fleetUserPathAllowed(path), path).toBe(false);
    }
  });
});

describe('FleetUserRoute', () => {
  it('sends a fleet user from any other page to its Dashboard', () => {
    renderAt('/stations');
    expect(screen.getByText('dashboard')).toBeTruthy();
    expect(screen.queryByText('page content')).toBeNull();
  });

  it('lets a fleet user open a fleet page', () => {
    renderAt('/fleets/flt_1');
    expect(screen.getByText('page content')).toBeTruthy();
  });

  it('never redirects a user with the sites scope', () => {
    auth.fleetUser = false;
    renderAt('/stations');
    expect(screen.getByText('page content')).toBeTruthy();
  });
});
