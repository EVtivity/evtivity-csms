// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { TFunction } from 'i18next';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { VehicleAcPhasesField, acPhasesOf, vehicleAcPhasesLabel } from '../VehicleAcPhasesField';

afterEach(() => {
  cleanup();
});

describe('VehicleAcPhasesField', () => {
  it('offers Not Known, Single Phase and Three Phase', () => {
    render(<VehicleAcPhasesField idPrefix="v" value={null} onChange={() => undefined} />);
    const select = screen.getByLabelText<HTMLSelectElement>('vehicles.acPhases');
    expect([...select.options].map((o) => o.value)).toEqual(['', '1', '3']);
    expect(select.value).toBe('');
  });

  it('reports the picked phase count and null for Not Known', () => {
    const onChange = vi.fn();
    render(<VehicleAcPhasesField idPrefix="v" value={1} onChange={onChange} />);
    const select = screen.getByLabelText<HTMLSelectElement>('vehicles.acPhases');
    expect(select.value).toBe('1');
    fireEvent.change(select, { target: { value: '3' } });
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('vehicle AC phases helpers', () => {
  const t = ((key: string) => key) as unknown as TFunction;

  it('reads only 1 or 3 from the API', () => {
    expect(acPhasesOf(1)).toBe(1);
    expect(acPhasesOf(3)).toBe(3);
    expect(acPhasesOf(2)).toBeNull();
    expect(acPhasesOf(null)).toBeNull();
    expect(acPhasesOf('3')).toBeNull();
  });

  it('labels a stored value and shows n/a when not known', () => {
    expect(vehicleAcPhasesLabel(1, t)).toBe('vehicles.acPhasesSingle');
    expect(vehicleAcPhasesLabel(3, t)).toBe('vehicles.acPhasesThree');
    expect(vehicleAcPhasesLabel(null, t)).toBe('n/a');
  });
});
