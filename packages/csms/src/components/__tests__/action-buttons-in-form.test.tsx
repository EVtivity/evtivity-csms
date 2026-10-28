// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AddButton } from '../add-button';
import { RefreshButton } from '../refresh-button';
import { ResetButton } from '../reset-button';
import { RemoveIconButton } from '../remove-icon-button';
import { SaveButton } from '../save-button';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
});

/** A form whose submit is recorded, with one action button inside it. */
function renderInForm(button: React.ReactNode): ReturnType<typeof vi.fn> {
  const onSubmit = vi.fn((e: React.SyntheticEvent) => {
    e.preventDefault();
  });
  render(<form onSubmit={onSubmit}>{button}</form>);
  return onSubmit;
}

describe('shared action buttons inside a form', () => {
  it('runs the Add action without submitting the form', () => {
    const onClick = vi.fn();
    const onSubmit = renderInForm(<AddButton label="Add" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('runs Refresh and a remove icon button without submitting the form', () => {
    const onRefresh = vi.fn();
    const onRemove = vi.fn();
    const onSubmit = renderInForm(
      <>
        <RefreshButton label="Refresh" onClick={onRefresh} />
        <RemoveIconButton title="Remove" onClick={onRemove} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('resets next to Save without submitting, and Save still submits', () => {
    const onReset = vi.fn();
    const onSubmit = renderInForm(
      <>
        <ResetButton onClick={onReset} />
        <SaveButton isPending={false} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'common.reset' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('submits the form when the caller asks for a submit button', () => {
    const onSubmit = renderInForm(<AddButton label="Add" onClick={vi.fn()} type="submit" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
