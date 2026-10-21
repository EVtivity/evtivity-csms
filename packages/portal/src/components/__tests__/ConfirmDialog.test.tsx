// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ConfirmDialog } from '../ui/confirm-dialog';

afterEach(() => {
  cleanup();
});

describe('ConfirmDialog', () => {
  it('is a modal dialog named by its title and described by its description', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Cancel reservation?"
        description="The fee is not refunded."
        confirmLabel="Cancel reservation"
        onConfirm={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Cancel reservation?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('The fee is not refunded.');
  });

  it('renders nothing while closed', () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={() => {}}
        title="Hidden"
        description="Hidden"
        confirmLabel="OK"
        onConfirm={() => undefined}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms on Enter in a field when it is a form, and stays open when confirm answers false', () => {
    const onConfirm = vi.fn(() => false);
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        asForm
        onOpenChange={onOpenChange}
        title="Rename"
        description="Pick a name."
        confirmLabel="Save"
        onConfirm={onConfirm}
      >
        <input aria-label="Name" />
      </ConfirmDialog>,
    );
    const form = screen.getByLabelText('Name').closest('form');
    expect(form).not.toBeNull();
    if (form != null) fireEvent.submit(form);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('submit');
  });

  it('closes at once after a synchronous confirm', () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Regenerate"
        description="Old codes stop working."
        confirmLabel="Regenerate"
        onConfirm={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
