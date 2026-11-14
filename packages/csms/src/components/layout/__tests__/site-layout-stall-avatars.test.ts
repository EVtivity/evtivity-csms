// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { otherStallSessions, parseAvatarKey, stallAvatarKey } from '../site-layout-stall-avatars';

describe('stall avatars', () => {
  it('round-trips a stall key and keeps a station key as it is', () => {
    expect(parseAvatarKey(stallAvatarKey('sta_em4#u2', 1))).toEqual({
      viewId: 'sta_em4#u2',
      stall: 1,
    });
    expect(parseAvatarKey('sta_em4#u2')).toEqual({ viewId: 'sta_em4#u2' });
    expect(parseAvatarKey('sta_x@stallx')).toEqual({ viewId: 'sta_x@stallx' });
  });

  it("lists every other EVSE's session, never the station's own twice", () => {
    const a = { id: 'ses_a' };
    const b = { id: 'ses_b' };
    expect(otherStallSessions({ session: a, evses: [{ session: a }, { session: b }] })).toEqual([
      { stall: 1, session: b },
    ]);
    // The station session on EVSE 2: EVSE 1's driver gets the other avatar.
    expect(otherStallSessions({ session: b, evses: [{ session: a }, { session: b }] })).toEqual([
      { stall: 0, session: a },
    ]);
    expect(otherStallSessions({ session: a, evses: [{ session: a }, { session: null }] })).toEqual(
      [],
    );
  });
});
