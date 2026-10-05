// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import { ConfirmDialog } from '../ui/confirm-dialog';

afterEach(() => {
  cleanup();
});

describe('Dialog', () => {
  it('is a modal dialog named by its title and described by its description', async () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Disable codes</DialogTitle>
          <DialogDescription>Stations stop showing them.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Disable codes' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => {
      expect(dialog.getAttribute('aria-describedby')).not.toBeNull();
    });
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('Stations stop showing them.');
  });

  it('has no aria-describedby without a description', () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Only a title</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Only a title' });
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);
  });

  it('gives two open dialogs different title ids', () => {
    render(
      <>
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>First</DialogTitle>
          </DialogContent>
        </Dialog>
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>Second</DialogTitle>
          </DialogContent>
        </Dialog>
      </>,
    );
    expect(screen.getByRole('dialog', { name: 'First' })).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'Second' })).toBeDefined();
  });

  it('renders nothing while closed', () => {
    render(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Hidden</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ConfirmDialog is named by its title and described by its description', async () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Send invite?"
        description="The link expires in 7 days."
        confirmLabel="Send"
        onConfirm={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Send invite?' });
    await waitFor(() => {
      expect(dialog.getAttribute('aria-describedby')).not.toBeNull();
    });
    expect(
      document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('The link expires in 7 days.');
  });
});
