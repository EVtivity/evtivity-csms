// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  PORTAL_ORIGIN_PLACEHOLDER,
  STORAGE_ACCESS_ACTIONS,
  buildS3CorsExample,
  originOrPlaceholder,
  storageBrowserOrigins,
} from '../s3-cors-example';

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

  it('allows PUT with the Content-Type header and GET for Cloudflare R2', () => {
    const [rule] = parse(
      buildS3CorsExample('https://csms.example.com', 'https://portal.example.com', 'PUT'),
    ) as Array<CorsRule & { AllowedHeaders: string[] }>;
    expect(rule?.AllowedMethods).toEqual(['PUT', 'GET']);
    expect(rule?.AllowedHeaders).toEqual(['content-type']);
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

describe('storageBrowserOrigins', () => {
  it('lists the CSMS and portal origins once each', () => {
    expect(
      storageBrowserOrigins('https://csms.example.com/settings', 'https://portal.example.com/'),
    ).toEqual([
      { origin: 'https://csms.example.com', placeholder: false },
      { origin: 'https://portal.example.com', placeholder: false },
    ]);
    expect(storageBrowserOrigins('https://ev.example.com', 'https://ev.example.com/x')).toEqual([
      { origin: 'https://ev.example.com', placeholder: false },
    ]);
  });

  it('marks an unknown portal address as a placeholder', () => {
    expect(storageBrowserOrigins('https://csms.example.com', null)).toEqual([
      { origin: 'https://csms.example.com', placeholder: false },
      { origin: PORTAL_ORIGIN_PLACEHOLDER, placeholder: true },
    ]);
  });
});

describe('STORAGE_ACCESS_ACTIONS', () => {
  it('names the S3 actions the storage code uses', () => {
    expect(STORAGE_ACCESS_ACTIONS.map((a) => a.action)).toEqual([
      's3:PutObject',
      's3:GetObject',
      's3:DeleteObject',
      's3:ListBucket',
    ]);
  });
});
