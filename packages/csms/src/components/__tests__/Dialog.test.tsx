// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

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

  describe('Escape', () => {
    function Harness({
      busy = false,
      onClose,
    }: {
      busy?: boolean;
      onClose?: () => void;
    }): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Open
          </button>
          <Dialog
            open={open}
            dismissible={!busy}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) onClose?.();
            }}
          >
            <DialogContent>
              <DialogTitle>Edit</DialogTitle>
              <input aria-label="Name" autoFocus />
            </DialogContent>
          </Dialog>
        </>
      );
    }

    it('closes the dialog and returns focus to the trigger', () => {
      const onClose = vi.fn();
      render(<Harness onClose={onClose} />);
      const trigger = screen.getByRole('button', { name: 'Open' });
      trigger.focus();
      fireEvent.click(trigger);
      expect(screen.getByRole('dialog', { name: 'Edit' })).toBeDefined();
      expect(document.activeElement).toBe(screen.getByLabelText('Name'));

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(trigger);
    });

    it('ignores other keys', () => {
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.keyDown(document.body, { key: 'Enter' });
      expect(screen.getByRole('dialog', { name: 'Edit' })).toBeDefined();
    });

    it('stays open while not dismissible', () => {
      const onClose = vi.fn();
      render(<Harness busy onClose={onClose} />);
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.getByRole('dialog', { name: 'Edit' })).toBeDefined();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes only the topmost of two open dialogs', () => {
      const outer = vi.fn();
      const inner = vi.fn();
      render(
        <>
          <Dialog open onOpenChange={outer}>
            <DialogContent>
              <DialogTitle>Outer</DialogTitle>
            </DialogContent>
          </Dialog>
          <Dialog open onOpenChange={inner}>
            <DialogContent>
              <DialogTitle>Inner</DialogTitle>
            </DialogContent>
          </Dialog>
        </>,
      );
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(inner).toHaveBeenCalledWith(false);
      expect(outer).not.toHaveBeenCalled();
    });

    it('leaves Escape to a control that handled it', () => {
      const onOpenChange = vi.fn();
      render(
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>With combobox</DialogTitle>
            <input
              aria-label="Search"
              onKeyDown={(e) => {
                if (e.key === 'Escape') e.preventDefault();
              }}
            />
          </DialogContent>
        </Dialog>,
      );
      fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'Escape' });
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('ConfirmDialog closes on Escape but not while pending', () => {
      const onOpenChange = vi.fn();
      const props = {
        open: true,
        onOpenChange,
        title: 'Delete?',
        description: 'This cannot be undone.',
        confirmLabel: 'Delete',
        onConfirm: () => undefined,
      };
      const { rerender } = render(<ConfirmDialog {...props} isPending />);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onOpenChange).not.toHaveBeenCalled();

      rerender(<ConfirmDialog {...props} isPending={false} />);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
