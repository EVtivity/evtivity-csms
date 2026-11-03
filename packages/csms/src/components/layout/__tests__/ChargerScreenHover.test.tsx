// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'source' in opts ? `${key}:${String(opts['source'])}` : key,
    i18n: { language: 'en' },
  }),
}));

import { ChargerScreenHover, type ChargerScreenHoverProps } from '../ChargerScreenHover';

afterEach(cleanup);

const stations: ChargerScreenHoverProps['stations'] = [
  {
    id: 'sta_1',
    stationId: 'CS-1',
    screenMessage: {
      text: 'Welcome to Acme<br/>Plug in to start charging at any connector of this station',
      source: 'station_message_template',
    },
  },
  { id: 'sta_2', stationId: 'CS-2', screenMessage: null },
];

function Stage({ target }: { target: ChargerScreenHoverProps['target'] }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="stage">
      <ChargerScreenHover stageRef={ref} target={target} stations={stations} />
    </div>
  );
}

describe('ChargerScreenHover', () => {
  it('shows the full screen text of the hovered screen once the pointer moves', () => {
    const { rerender } = render(<Stage target={null} />);
    fireEvent.pointerMove(screen.getByTestId('stage'), { clientX: 10, clientY: 20 });
    expect(screen.queryByTestId('screen-message-zoom')).toBeNull();
    rerender(<Stage target={{ kind: 'dc', stationId: 'sta_1' }} />);
    const zoom = screen.getByTestId('screen-message-zoom');
    expect(zoom.textContent).toContain('CS-1');
    // The full text, never cut like the small screen.
    expect(screen.getByTestId('screen-message-zoom-frame').textContent).toBe(
      'Welcome to Acme\nPlug in to start charging at any connector of this station',
    );
    expect(zoom.textContent).toContain(
      'sites.layoutView.screenSourceLabel:sites.layoutView.screenSource.station_message_template',
    );
  });

  it('hides again when the screen is left', () => {
    const { rerender } = render(<Stage target={{ kind: 'ac57in', stationId: 'sta_1' }} />);
    fireEvent.pointerMove(screen.getByTestId('stage'), { clientX: 10, clientY: 20 });
    screen.getByTestId('screen-message-zoom');
    rerender(<Stage target={null} />);
    expect(screen.queryByTestId('screen-message-zoom')).toBeNull();
  });

  it('shows nothing for a station without screen text or an unknown station', () => {
    const { rerender } = render(<Stage target={{ kind: 'ac', stationId: 'sta_2' }} />);
    fireEvent.pointerMove(screen.getByTestId('stage'), { clientX: 10, clientY: 20 });
    expect(screen.queryByTestId('screen-message-zoom')).toBeNull();
    rerender(<Stage target={{ kind: 'ac', stationId: 'sta_9' }} />);
    expect(screen.queryByTestId('screen-message-zoom')).toBeNull();
  });
});
