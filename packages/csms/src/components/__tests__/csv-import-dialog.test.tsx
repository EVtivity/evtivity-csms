// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The CSV import confirm dialog and result card shared by the Sites and SIMs
// lists: the same texts and behavior the Sites page had inline.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));

import { CsvImportDialog, CsvImportResultCard } from '@/components/csv-import-dialog';
import { ApiError } from '@/lib/api';

afterEach(() => {
  cleanup();
});

function renderDialog(overrides: Partial<Parameters<typeof CsvImportDialog>[0]> = {}): {
  onConfirm: ReturnType<typeof vi.fn>;
  onOpenChange: ReturnType<typeof vi.fn>;
  onUpdateExistingChange: ReturnType<typeof vi.fn>;
} {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  const onUpdateExistingChange = vi.fn();
  render(
    <CsvImportDialog
      open
      onOpenChange={onOpenChange}
      title="Import Things"
      rowCount={3}
      filename="things.csv"
      updateExisting={false}
      onUpdateExistingChange={onUpdateExistingChange}
      isPending={false}
      error={null}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onConfirm, onOpenChange, onUpdateExistingChange };
}

describe('CsvImportDialog', () => {
  it('names the row count and file, and imports on confirm', () => {
    const { onConfirm } = renderDialog();
    expect(screen.getByText('Import Things')).toBeDefined();
    expect(
      screen.getByText('sites.importConfirmMessage:{"count":3,"filename":"things.csv"}'),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'sites.importCsv' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('toggles Update Existing and shows its description', () => {
    const { onUpdateExistingChange } = renderDialog();
    expect(screen.getByText('sites.updateExistingDescription')).toBeDefined();
    fireEvent.click(screen.getByRole('checkbox', { name: 'sites.updateExisting' }));
    expect(onUpdateExistingChange).toHaveBeenCalledWith(true);
  });

  it('uses the shared Checkbox named by a Label', () => {
    renderDialog();
    const box = screen.getByRole('checkbox', { name: 'sites.updateExisting' });
    // The shared Checkbox draws its own box (appearance-none) and a check icon beside it.
    expect(box.className).toContain('appearance-none');
    expect(box.id).not.toBe('');
    expect(document.querySelector(`label[for="${box.id}"]`)?.textContent).toBe(
      'sites.updateExisting',
    );
  });

  it('shows Importing and disables the button while the import runs', () => {
    renderDialog({ isPending: true });
    const button = screen.getByRole('button', { name: 'sites.importing' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the error of a failed import', () => {
    renderDialog({
      error: new ApiError(400, { error: 'Too many rows', code: 'VALIDATION_ERROR' }),
    });
    expect(screen.getByText(/VALIDATION_ERROR|Too many rows|errors\./)).toBeDefined();
  });

  it('closes on Cancel', () => {
    const { onOpenChange, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('CsvImportResultCard', () => {
  it('lists the result lines and the row errors', () => {
    render(<CsvImportResultCard lines={['Created: 2']} errors={['Row 3: bad ICCID']} />);
    expect(screen.getByText('sites.importResults')).toBeDefined();
    expect(screen.getByText('Created: 2')).toBeDefined();
    expect(screen.getByText('Row 3: bad ICCID')).toBeDefined();
    expect(screen.getByText(/sites\.importErrors/)).toBeDefined();
  });

  it('shows no error list without errors', () => {
    render(<CsvImportResultCard lines={['Created: 2']} errors={[]} />);
    expect(screen.queryByText(/sites\.importErrors/)).toBeNull();
  });
});
