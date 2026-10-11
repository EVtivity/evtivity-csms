// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const { state } = vi.hoisted(() => ({
  state: { isAuthenticated: false, isHydrating: false },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: typeof state) => unknown) => selector(state),
}));

import { ProtectedRoute } from '../ProtectedRoute';

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<Where />} />
        <Route
          path="*"
          element={
            <ProtectedRoute>
              <Where />
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  state.isAuthenticated = false;
});

describe('ProtectedRoute return-to', () => {
  it('sends a signed-out user to sign in with the deep link as returnTo', () => {
    renderAt('/ai/inbox/p1?x=1');
    expect(screen.getByTestId('where').textContent).toBe(
      '/login?returnTo=%2Fai%2Finbox%2Fp1%3Fx%3D1',
    );
  });

  it('after an SSO login (which lands on /) opens the remembered page once', () => {
    state.isAuthenticated = true;
    sessionStorage.setItem('csms_return_to', '/ai/inbox/p1');
    renderAt('/');
    expect(screen.getByTestId('where').textContent).toBe('/ai/inbox/p1');
    expect(sessionStorage.getItem('csms_return_to')).toBeNull();
  });

  it('ignores a remembered value that is not a same-origin path', () => {
    state.isAuthenticated = true;
    sessionStorage.setItem('csms_return_to', '//evil.example');
    renderAt('/');
    expect(screen.getByTestId('where').textContent).toBe('/');
  });
});
