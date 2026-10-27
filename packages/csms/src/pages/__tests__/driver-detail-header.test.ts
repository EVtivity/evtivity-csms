// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import source from '../DriverDetail.tsx?raw';

describe('Driver detail header', () => {
  it('puts the actions and Prev and Next in their own row, right-aligned from sm', () => {
    const wrapper =
      'flex flex-col gap-4 *:w-full sm:flex-row sm:items-start sm:justify-between sm:*:w-auto';
    const wrapperAt = source.indexOf(`className="${wrapper}"`);
    const titleAt = source.indexOf(
      'className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2"',
    );
    const actionsAt = source.indexOf('data-testid="driver-header-actions"');
    const navAt = source.indexOf('<EntityNavButtons resource="drivers"');
    const badgeEnd = source.indexOf('</Badge>');

    expect(wrapperAt).toBeGreaterThan(-1);
    expect(titleAt).toBeGreaterThan(wrapperAt);
    // The actions row starts after the title group closes, so it is not part of the title row.
    expect(actionsAt).toBeGreaterThan(badgeEnd);
    expect(source.slice(badgeEnd, actionsAt)).toContain('</div>');
    expect(navAt).toBeGreaterThan(actionsAt);
  });

  it('keeps avatar editing out of the header: it lives in the Details tab edit form', () => {
    expect(source).not.toContain('DriverAvatarEditButton');
    expect(source).not.toContain('DriverAvatarRemoveButton');
    expect(source).not.toContain('AvatarEditor');
    expect(source).not.toContain('AvatarField');
  });
});
