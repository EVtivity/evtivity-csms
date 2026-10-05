// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

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
});
