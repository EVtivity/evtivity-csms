// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/lib/api', () => ({ api: { post: postMock } }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

import { QrLanding } from '../QrLanding';

function ChargerPage(): React.JSX.Element {
  const location = useLocation();
  return <p>{`charger ${location.pathname}${location.search}`}</p>;
}

function renderAt(path: string): void {
  window.history.pushState({}, '', path);
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/qr/*" element={<QrLanding />} />
        <Route path="/charge/:stationId/:evseId" element={<ChargerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  postMock.mockReset();
});

describe('QrLanding', () => {
  it('sends the scanned URL and continues to the charger page with the limits', async () => {
    postMock.mockResolvedValue({ valid: true, stationId: 'CS-1', evseId: 1 });
    renderAt('/qr/CS-1/1/aHicux89/v1?maxenergy=20000');

    expect(await screen.findByText('charger /charge/CS-1/1?maxenergy=20000')).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith('/v1/portal/guest/qr/validate', {
      url: 'http://localhost:3000/qr/CS-1/1/aHicux89/v1?maxenergy=20000',
    });
  });

  it('stops on an invalid QR code', async () => {
    postMock.mockResolvedValue({ valid: false, reason: 'invalid_totp' });
    renderAt('/qr/CS-1/1/WRONG000/v1');

    expect(await screen.findByText('qr.invalidTitle')).toBeTruthy();
    expect(screen.getByText('qr.invalidMessage')).toBeTruthy();
  });

  it('treats a failed check as invalid', async () => {
    postMock.mockRejectedValue(new Error('network'));
    renderAt('/qr/1/aHicux89/v1');

    await waitFor(() => {
      expect(screen.getByText('qr.invalidTitle')).toBeTruthy();
    });
  });
});
