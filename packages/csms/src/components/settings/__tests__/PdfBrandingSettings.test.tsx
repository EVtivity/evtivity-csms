// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { put, canWrite } = vi.hoisted(() => ({
  put: vi.fn(() => Promise.resolve({})),
  canWrite: { value: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({ api: { put } }));

vi.mock('@/lib/auth', () => ({
  useHasCompanyWidePermission: () => canWrite.value,
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { PdfBrandingSettings } from '../PdfBrandingSettings';

beforeEach(() => {
  canWrite.value = true;
});

afterEach(() => {
  cleanup();
});

function renderWith(settings: Record<string, unknown> | undefined): void {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <PdfBrandingSettings settings={settings} />
    </QueryClientProvider>,
  );
}

describe('PdfBrandingSettings', () => {
  it('previews the default logo when pdf.logo is empty, without a reset button', () => {
    renderWith({ 'pdf.logo': '', 'pdf.footer': '' });
    const img = screen.getByAltText('settings.pdfLogo');
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
    expect(screen.getByText('settings.pdfLogoDefault')).toBeTruthy();
    expect(screen.queryByText('settings.pdfLogoReset')).toBeNull();
    expect(screen.getByText('settings.pdfLogoHelp')).toBeTruthy();
  });

  it('previews an uploaded logo and resets it to the default', async () => {
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    renderWith({ 'pdf.logo': logo });
    expect(screen.getByAltText('settings.pdfLogo').getAttribute('src')).toBe(logo);
    fireEvent.click(screen.getByText('settings.pdfLogoReset'));
    await waitFor(() => {
      expect(put).toHaveBeenCalledWith('/v1/settings/pdf.logo', { value: '' });
    });
  });

  it('shows the stored footer without a preview', () => {
    renderWith({ 'pdf.footer': 'www.evtivity.com' });
    expect(screen.getByLabelText('settings.pdfFooter')).toHaveProperty('value', 'www.evtivity.com');
    expect(screen.getByText('settings.pdfFooterHelp')).toBeTruthy();
    expect(screen.queryByText('settings.pdfFooterPreview')).toBeNull();
    expect(screen.queryByTestId('pdf-footer-preview')).toBeNull();
  });

  it('saves the footer normalized', async () => {
    renderWith({ 'pdf.footer': '' });
    fireEvent.change(screen.getByLabelText('settings.pdfFooter'), {
      target: { value: 'Acme GmbH  \nMain St 1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(put).toHaveBeenCalledWith('/v1/settings/pdf.footer', {
        value: 'Acme GmbH\nMain St 1',
      });
    });
  });

  it('flags a footer with too many lines', () => {
    renderWith({ 'pdf.footer': '' });
    fireEvent.change(screen.getByLabelText('settings.pdfFooter'), {
      target: { value: 'a\nb\nc\nd\ne\nf' },
    });
    expect(screen.getByText('settings.pdfFooterInvalid')).toBeTruthy();
  });

  it('disables every control without settings write access', () => {
    canWrite.value = false;
    renderWith({ 'pdf.logo': 'data:image/png;base64,iVBORw0KGgo=', 'pdf.footer': 'Footer' });
    expect(screen.getByLabelText('settings.pdfFooter').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('settings.pdfLogoReset').closest('button')?.disabled).toBe(true);
    expect(screen.getByText('settings.pdfLogoUpload').closest('button')?.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });
});
