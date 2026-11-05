// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: [], total: 0 }) },
}));

import { DepotSystemFields, emptyDepotSystemForm } from '../DepotSystemFields';

afterEach(() => {
  cleanup();
});

/** The row (parent element) holding the field of `labelText`. */
function rowOf(labelText: string): HTMLElement {
  const field = screen.getByText(labelText).parentElement;
  const row = field?.parentElement;
  if (row == null) throw new Error(`no row for ${labelText}`);
  return row;
}

describe('DepotSystemFields', () => {
  it('keeps the fields of each row top aligned, also when only one has helper text', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DepotSystemFields
          idPrefix="t"
          values={emptyDepotSystemForm()}
          onChange={vi.fn()}
          errors={{}}
          creating
        />
      </QueryClientProvider>,
    );
    // Name (no helper text) and Type (helper text below): the row must not stretch
    // the Name field, or its input sits lower than the Type select.
    const nameRow = rowOf('depotSystems.name');
    expect(nameRow).toBe(rowOf('depotSystems.type'));
    expect(nameRow.className).toContain('sm:grid-cols-2');
    expect(nameRow.className.split(' ')).toContain('items-start');
    // The connection timings share their own two-column rows.
    fireEvent.click(screen.getByRole('button', { name: 'depotSystems.connectionTimings' }));
    const timingRow = rowOf('depotSystems.timings.requestTimeoutSeconds');
    expect(timingRow.className.split(' ')).toContain('items-start');
  });
});
