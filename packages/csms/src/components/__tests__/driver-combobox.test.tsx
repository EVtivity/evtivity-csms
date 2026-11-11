// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The driver picker shows its pick like the station picker: a read-only field
// with an X that clears it, named by its Label.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get } }));

import { DriverCombobox } from '@/components/driver-combobox';
import { StationCombobox } from '@/components/station-combobox';
import { Label } from '@/components/ui/label';

afterEach(cleanup);

describe('DriverCombobox', () => {
  it('shows the picked driver in a read-only field named by its Label', () => {
    render(
      <>
        <Label htmlFor="pick">Driver</Label>
        <DriverCombobox
          id="pick"
          value={{ id: 'drv_1', name: 'Ada Lovelace' }}
          onSelect={() => undefined}
        />
      </>,
    );
    const field = screen.getByLabelText('Driver');
    expect(field.tagName).toBe('INPUT');
    expect((field as HTMLInputElement).value).toBe('Ada Lovelace');
    expect(field.hasAttribute('readonly')).toBe(true);
  });

  it('clears the pick with the X', () => {
    const onSelect = vi.fn();
    render(<DriverCombobox value={{ id: 'drv_1', name: 'Ada Lovelace' }} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.clear' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('names the picked field without a Label', () => {
    render(
      <DriverCombobox value={{ id: 'drv_1', name: 'Ada Lovelace' }} onSelect={() => undefined} />,
    );
    expect(screen.getByLabelText<HTMLInputElement>('tokens.driver').value).toBe('Ada Lovelace');
  });

  it('marks a form error on the picked field', () => {
    render(
      <DriverCombobox
        invalid
        value={{ id: 'drv_1', name: 'Ada Lovelace' }}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByLabelText('tokens.driver').getAttribute('aria-invalid')).toBe('true');
  });

  it('draws the pick with the same classes as the station picker', () => {
    const { container: driver } = render(
      <DriverCombobox value={{ id: 'drv_1', name: 'Ada' }} onSelect={() => undefined} />,
    );
    const { container: station } = render(
      <StationCombobox value={{ id: 'sta_1', stationId: 'CS-001' }} onSelect={() => undefined} />,
    );
    const driverInput = driver.querySelector('input');
    const stationInput = station.querySelector('input');
    expect(driverInput?.className).toBe(stationInput?.className);
    expect(driverInput?.parentElement?.className).toBe(stationInput?.parentElement?.className);
  });
});
