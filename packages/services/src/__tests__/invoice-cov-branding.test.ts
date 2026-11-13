// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// `resolvePdfLogo` when the SVG rasterizer fails: the default logo is used
// (null) and the failure is logged, never thrown into the PDF generation.

import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@evtivity/database', () => ({ client: vi.fn() }));

vi.mock('@resvg/resvg-js', () => ({
  Resvg: vi.fn(function Resvg() {
    throw new Error('SVG has an invalid size');
  }),
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createLogger: () => ({ warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { resolvePdfLogo } = await import('../pdf-branding.js');

describe('resolvePdfLogo with a failing rasterizer', () => {
  it('returns null and warns for an SVG it cannot render', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    const value = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    expect(resolvePdfLogo(value)).toBeNull();
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to render the pdf.logo SVG, using the default logo',
    );
  });

  it('returns null without rasterizing for an unset or blank value', () => {
    h.warn.mockClear();
    expect(resolvePdfLogo(null)).toBeNull();
    expect(resolvePdfLogo('   ')).toBeNull();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
