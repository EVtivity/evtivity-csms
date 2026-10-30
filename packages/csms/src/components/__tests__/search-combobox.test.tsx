// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The shared search picker: a combobox field with a listbox of results that
// the mouse and the keyboard can pick from.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { SearchCombobox } from '../ui/search-combobox';

// jsdom has no layout: the highlighted result scrolls into view through this stub.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

const ITEMS = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Bravo' },
];

function Harness({
  onSelect,
  onClose,
}: {
  onSelect: (id: string) => void;
  onClose?: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  return (
    <SearchCombobox
      aria-label="Find"
      query={query}
      onQueryChange={setQuery}
      items={query === '' ? [] : ITEMS.filter((i) => i.name.toLowerCase().includes(query))}
      getKey={(i) => i.id}
      renderItem={(i) => i.name}
      onSelect={(i) => {
        onSelect(i.id);
      }}
      onClose={onClose}
      closeLabel="Close"
    />
  );
}

describe('SearchCombobox', () => {
  it('opens a listbox of results and picks one with a click', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole('combobox', { name: 'Find' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(input, { target: { value: 'a' } });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox').id).toBe(input.getAttribute('aria-controls'));
    fireEvent.click(screen.getByRole('option', { name: 'Bravo' }));
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('moves with the arrow keys, picks with Enter and closes with Escape', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('a');

    fireEvent.change(input, { target: { value: 'b' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on a click outside and offers a named close button', () => {
    const onClose = vi.fn();
    render(<Harness onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a' } });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('is 40 px and marks a form error', () => {
    render(
      <SearchCombobox
        aria-label="Find"
        invalid
        query=""
        onQueryChange={vi.fn()}
        items={[]}
        getKey={() => ''}
        renderItem={() => null}
        onSelect={vi.fn()}
      />,
    );
    const input = screen.getByRole('combobox');
    expect(input.className.split(/\s+/)).toContain('h-10');
    expect(input.className).toContain('border-destructive');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
