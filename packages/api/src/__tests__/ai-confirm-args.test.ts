// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { confirmationArguments } from '../services/ai/engine/confirm-args.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlc2lnbmF0dXJl';

describe('confirmation card arguments', () => {
  it('counts a JWT-shaped body value the card masks', () => {
    const shown = confirmationArguments(
      { name: 'Welcome', bodyHtml: `<a href="https://x.example/?t=${JWT}">Open</a>` },
      'chatbot',
    );
    expect(shown.maskedCount).toBe(1);
    expect(JSON.stringify(shown.displayArgs)).not.toContain(JWT);
    expect(shown.displayArgs['name']).toBe('Welcome');
  });

  it('counts nothing when the card shows every value', () => {
    expect(confirmationArguments({ name: 'Renamed', limit: 5 }, 'chatbot')).toEqual({
      displayArgs: { name: 'Renamed', limit: 5 },
      maskedCount: 0,
    });
  });
});
