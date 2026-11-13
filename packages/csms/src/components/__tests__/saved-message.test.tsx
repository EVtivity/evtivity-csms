// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

const toastMock = vi.fn();
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { SavedMessage, useCreatedToast, useSavedToast } from '../saved-message';
import { CreateButton } from '../create-button';
import { ButtonSpinner } from '../ui/button-spinner';
import { ButtonPendingLabel } from '../ButtonPendingLabel';

function ToastProbe(): React.JSX.Element {
  const savedToast = useSavedToast();
  return (
    <button type="button" onClick={savedToast}>
      save
    </button>
  );
}

describe('save feedback', () => {
  afterEach(cleanup);

  it('shows the shared saved text as a status, or a more specific one', () => {
    const { rerender } = render(<SavedMessage />);
    expect(screen.getByRole('status').textContent).toBe('common.saved');
    rerender(<SavedMessage>settings.storage.saved</SavedMessage>);
    expect(screen.getByRole('status').textContent).toBe('settings.storage.saved');
  });

  it('raises the success toast with the shared saved text', () => {
    render(<ToastProbe />);
    fireEvent.click(screen.getByRole('button'));
    expect(toastMock).toHaveBeenCalledWith({ variant: 'success', title: 'common.saved' });
  });

  it('draws the pending ring in the button text color, never the logo', () => {
    render(<ButtonSpinner />);
    const ring = screen.getByTestId('button-spinner');
    expect(ring.tagName).toBe('SPAN');
    expect(ring.className).toContain('border-current/25');
    expect(ring.className).toContain('animate-spin');
  });

  it('raises the created toast of a create page', () => {
    function CreatedProbe(): React.JSX.Element {
      const createdToast = useCreatedToast();
      return (
        <button type="button" onClick={createdToast}>
          create
        </button>
      );
    }
    render(<CreatedProbe />);
    fireEvent.click(screen.getByRole('button'));
    expect(toastMock).toHaveBeenCalledWith({
      variant: 'success',
      title: 'common.createdSuccessfully',
    });
  });

  it('disables a pending CreateButton and shows the ring over its label', () => {
    render(<CreateButton label="payments.addCard" pending />);
    const button = screen.getByRole('button');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('button-spinner')).toBeTruthy();
  });

  it('keeps the label in place while pending', () => {
    render(<ButtonPendingLabel pending>Save</ButtonPendingLabel>);
    expect(screen.getByTestId('button-spinner')).toBeTruthy();
    expect(screen.getByText('Save').className).toContain('invisible');
  });
});
