// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { buildS3CorsExample, originOrPlaceholder } from '../s3-cors-example';

interface CorsRule {
  AllowedMethods: string[];
  AllowedOrigins: string[];
}

function parse(json: string): CorsRule[] {
  return JSON.parse(json) as CorsRule[];
}

describe('buildS3CorsExample', () => {
  it('allows POST and GET from the CSMS and the portal origin', () => {
    const [rule] = parse(
      buildS3CorsExample('https://csms.example.com/settings', 'https://portal.example.com/'),
    );
    expect(rule?.AllowedMethods).toEqual(['POST', 'GET']);
    expect(rule?.AllowedMethods).not.toContain('PUT');
    expect(rule?.AllowedOrigins).toEqual([
      'https://csms.example.com',
      'https://portal.example.com',
    ]);
  });

  it('keeps the port of each origin', () => {
    const [rule] = parse(buildS3CorsExample('http://localhost:7100', 'http://localhost:7101'));
    expect(rule?.AllowedOrigins).toEqual(['http://localhost:7100', 'http://localhost:7101']);
  });

  it('shows placeholders for a missing or unparsable URL', () => {
    const [rule] = parse(buildS3CorsExample(null, 'not a url'));
    expect(rule?.AllowedOrigins).toEqual(['YOUR_CSMS_ORIGIN', 'YOUR_PORTAL_ORIGIN']);
  });

  it('lists one origin once when both apps share it', () => {
    const [rule] = parse(buildS3CorsExample('https://ev.example.com', 'https://ev.example.com'));
    expect(rule?.AllowedOrigins).toEqual(['https://ev.example.com']);
  });
});

describe('originOrPlaceholder', () => {
  it('refuses a non-http scheme', () => {
    expect(originOrPlaceholder('ftp://files.example.com', 'X')).toBe('X');
  });
});
