// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Radio } from '../ui/radio';

afterEach(cleanup);

describe('Radio', () => {
  it('is a native radio named by its label and reports a change', () => {
    const onChange = vi.fn();
    render(
      <>
        <label>
          <Radio name="mode" value="a" onChange={onChange} /> A
        </label>
        <label>
          <Radio name="mode" value="b" error /> B
        </label>
      </>,
    );
    const a = screen.getByRole('radio', { name: 'A' });
    fireEvent.click(a);
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'B' }).className).toContain('border-destructive');
  });
});
