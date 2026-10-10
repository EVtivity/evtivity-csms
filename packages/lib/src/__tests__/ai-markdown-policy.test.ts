// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { allowedAiLink, buildAiLinkAllowlist } from '../ai-markdown-policy.js';

describe('ai-markdown-policy', () => {
  const allowlist = buildAiLinkAllowlist([
    'https://csms.example.com',
    'https://portal.example.com:8443/some/path',
    'http://insecure.example.com',
    '',
    null,
  ]);

  it('always allows the website and keeps only https origins', () => {
    expect(allowlist).toEqual([
      'https://evtivity.com',
      'https://www.evtivity.com',
      'https://csms.example.com',
      'https://portal.example.com:8443',
    ]);
  });

  it('TC-AI-M-02: refuses javascript:, data:, http:, relative and off-list links', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://evtivity.com/docs',
      '/v1/settings',
      'https://evil.example.com/?q=secret',
      'https://evtivity.com.evil.example.com/',
      'https://user:pass@evtivity.com/',
      '',
      '   ',
      null,
      undefined,
    ]) {
      expect(allowedAiLink(href, allowlist), String(href)).toBeNull();
    }
  });

  it('allows https links on the allowlist and normalizes them', () => {
    expect(allowedAiLink('https://evtivity.com/en/docs/csms', allowlist)).toBe(
      'https://evtivity.com/en/docs/csms',
    );
    expect(allowedAiLink(' https://CSMS.example.com/stations/1 ', allowlist)).toBe(
      'https://csms.example.com/stations/1',
    );
    expect(allowedAiLink('https://portal.example.com:8443/x', allowlist)).toBe(
      'https://portal.example.com:8443/x',
    );
    expect(allowedAiLink('https://portal.example.com/x', allowlist)).toBeNull();
  });
});
