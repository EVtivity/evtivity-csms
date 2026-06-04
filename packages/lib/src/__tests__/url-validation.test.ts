// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { isPrivateUrl } from '../url-validation.js';

// These tests assert the real, observable behavior of isPrivateUrl. They are
// written against Node's WHATWG URL parser, which is what the function uses.
// The parser returns IPv6 literals WITH their surrounding brackets (e.g.
// "[::1]"); isPrivateUrl strips the brackets before isIP() so the IPv6
// private-range checks apply. An http(s) URL with an empty authority throws in
// the parser, so the hostname==='' guard is reached only via the catch path.

describe('isPrivateUrl', () => {
  describe('protocol rejection', () => {
    it('treats non-http(s) schemes as private', () => {
      expect(isPrivateUrl('file:///etc/passwd')).toBe(true);
      expect(isPrivateUrl('ftp://example.com/file')).toBe(true);
      expect(isPrivateUrl('gopher://example.com')).toBe(true);
      expect(isPrivateUrl('dict://example.com')).toBe(true);
      expect(isPrivateUrl('ws://example.com')).toBe(true);
      expect(isPrivateUrl('data:text/plain,hello')).toBe(true);
    });

    it('allows http and https for public hosts', () => {
      expect(isPrivateUrl('http://example.com')).toBe(false);
      expect(isPrivateUrl('https://example.com/webhook')).toBe(false);
    });
  });

  describe('localhost hostname', () => {
    it('treats localhost as private regardless of port or path', () => {
      expect(isPrivateUrl('http://localhost')).toBe(true);
      expect(isPrivateUrl('http://localhost:8080/path')).toBe(true);
      expect(isPrivateUrl('https://localhost')).toBe(true);
    });

    it('does not treat a hostname that merely contains localhost as private', () => {
      expect(isPrivateUrl('http://localhost.example.com')).toBe(false);
      expect(isPrivateUrl('http://mylocalhost')).toBe(false);
    });
  });

  describe('private IPv4 ranges', () => {
    const privateV4 = [
      'http://127.0.0.1',
      'http://127.255.255.255',
      'http://10.0.0.1',
      'http://10.255.255.255',
      'http://172.16.0.1',
      'http://172.20.5.5',
      'http://172.31.255.255',
      'http://192.168.0.1',
      'http://192.168.255.255',
      'http://169.254.0.1',
      'http://0.0.0.0',
      'http://0.1.2.3',
      'http://100.64.0.1',
      'http://100.127.255.255',
    ];
    it.each(privateV4)('treats %s as private', (url) => {
      expect(isPrivateUrl(url)).toBe(true);
    });

    it('honors the private check on https as well', () => {
      expect(isPrivateUrl('https://10.0.0.1/webhook')).toBe(true);
    });
  });

  describe('public IPv4 addresses', () => {
    const publicV4 = [
      'http://8.8.8.8',
      'http://1.1.1.1',
      'http://172.15.0.1', // just below the 172.16-31 private block
      'http://172.32.0.1', // just above the 172.16-31 private block
      'http://192.169.0.1', // not 192.168
      'http://100.63.255.255', // just below CGNAT 100.64-127
      'http://100.128.0.1', // just above CGNAT 100.64-127
      'http://11.0.0.1',
      'http://9.9.9.9',
    ];
    it.each(publicV4)('treats %s as public', (url) => {
      expect(isPrivateUrl(url)).toBe(false);
    });
  });

  describe('IPv6 literals (brackets stripped, then private-range checked)', () => {
    // Private/loopback/ULA/link-local IPv6 and IPv4-mapped-private must be blocked.
    const privateV6 = [
      'http://[::1]', // loopback
      'http://[::]', // unspecified
      'http://[fc00::1]', // ULA fc00::/7
      'http://[fd00::1]', // ULA fd00::/8
      'http://[fe80::1]', // link-local
      'http://[fea0::1]', // link-local fe80::/10 upper
      'http://[::ffff:127.0.0.1]', // IPv4-mapped loopback
      'http://[::ffff:10.0.0.1]', // IPv4-mapped private
      'http://[::192.168.1.1]', // IPv4-compatible private
    ];
    it.each(privateV6)('returns true (private) for %s', (url) => {
      expect(isPrivateUrl(url)).toBe(true);
    });

    // Public/global IPv6 (and IPv4-mapped public) must be allowed.
    const publicV6 = [
      'http://[2001:4860:4860::8888]', // Google public DNS
      'http://[2607:f8b0:4005:80a::200e]', // global unicast
      'http://[::ffff:8.8.8.8]', // IPv4-mapped public
    ];
    it.each(publicV6)('returns false (public) for %s', (url) => {
      expect(isPrivateUrl(url)).toBe(false);
    });
  });

  describe('internal hostname suffixes', () => {
    it('treats .local and .internal hostnames as private', () => {
      expect(isPrivateUrl('http://myhost.local')).toBe(true);
      expect(isPrivateUrl('http://service.internal')).toBe(true);
      expect(isPrivateUrl('https://db.internal:5432')).toBe(true);
    });

    it('treats ordinary public hostnames as public', () => {
      expect(isPrivateUrl('http://example.com')).toBe(false);
      expect(isPrivateUrl('https://api.partner.io/webhook')).toBe(false);
      expect(isPrivateUrl('http://internal.example.com')).toBe(false);
      expect(isPrivateUrl('http://local.example.com')).toBe(false);
    });
  });

  describe('malformed and invalid URLs', () => {
    it('treats unparseable input as private via the catch path', () => {
      expect(isPrivateUrl('not a url')).toBe(true);
      expect(isPrivateUrl('')).toBe(true);
      expect(isPrivateUrl('http://')).toBe(true);
      expect(isPrivateUrl('http:///path')).toBe(false); // hostname parses to "path", a public name
      expect(isPrivateUrl('://missing-scheme')).toBe(true);
      expect(isPrivateUrl('http://[invalid')).toBe(true);
    });
  });
});
