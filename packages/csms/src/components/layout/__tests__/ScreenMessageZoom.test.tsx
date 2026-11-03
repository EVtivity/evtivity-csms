// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'source' in opts ? `${key}:${String(opts['source'])}` : key,
    i18n: { language: 'en' },
  }),
}));

import { ScreenMessageZoom, SCREEN_ZOOM_GAP, screenZoomTextClass } from '../ScreenMessageZoom';

afterEach(cleanup);

const bounds = { left: 0, top: 0, width: 800, height: 600 };

describe('ScreenMessageZoom', () => {
  it('shows the station name, the screen frame and its text with the template line breaks', () => {
    render(
      <ScreenMessageZoom
        stationName="CS-3050"
        text={'Acme<br/>CS-3050\nPlug in to start'}
        kind="dc7in"
        anchor={{ x: 100, y: 200 }}
        bounds={bounds}
        source="station_message_template"
      />,
    );
    const zoom = screen.getByRole('tooltip');
    expect(zoom.textContent).toContain('CS-3050');
    screen.getByText('sites.layoutView.screenZoomLabel');
    expect(screen.getByTestId('screen-message-zoom-frame').textContent).toBe(
      'Acme\nCS-3050\nPlug in to start',
    );
    screen.getByText(
      'sites.layoutView.screenSourceLabel:sites.layoutView.screenSource.station_message_template',
    );
    // It never takes the pointer, so the hover on the screen stays.
    expect(zoom.className).toContain('pointer-events-none');
  });

  it('keeps the screen shape of the charger model', () => {
    render(
      <ScreenMessageZoom
        stationName="CS-1"
        text="Welcome"
        kind="ac57in"
        anchor={{ x: 10, y: 10 }}
        bounds={bounds}
      />,
    );
    const shape = screen.getByText('Welcome').parentElement;
    expect(shape?.style.aspectRatio).toBe('256 / 192');
    expect(screen.queryByText(/screenSourceLabel/)).toBeNull();
  });

  it('opens beside the pointer inside the container', () => {
    render(
      <ScreenMessageZoom
        stationName="CS-1"
        text="Welcome"
        kind="dc"
        anchor={{ x: 120, y: 300 }}
        bounds={bounds}
      />,
    );
    const zoom = screen.getByRole('tooltip');
    expect(zoom.style.left).toBe(`${String(120 + SCREEN_ZOOM_GAP)}px`);
    expect(Number.parseFloat(zoom.style.top)).toBeGreaterThanOrEqual(0);
  });
});

describe('screenZoomTextClass', () => {
  it('uses a smaller size for longer text', () => {
    expect(screenZoomTextClass('Welcome to Acme')).toBe('text-lg');
    expect(screenZoomTextClass('x'.repeat(100))).toBe('text-base');
    expect(screenZoomTextClass('x'.repeat(300))).toBe('text-sm');
  });
});
