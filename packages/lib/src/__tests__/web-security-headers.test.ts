// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The CSMS and portal pages are served with anti-framing, content
// type, referrer and transport headers and a CSP header (a meta CSP cannot set
// frame-ancestors). Lives in lib: the app test projects have no Node types.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const SNIPPET_PATH = '/etc/nginx/evtivity-security-headers.conf';

/** The body of each `location` block (no nested blocks in these configs). */
function locations(conf: string): Array<{ match: string; body: string }> {
  return [...conf.matchAll(/location\s+([^{]+)\{([^}]*)\}/g)].map((m) => ({
    match: (m[1] ?? '').trim(),
    body: m[2] ?? '',
  }));
}

describe.each(['csms', 'portal'])('%s security headers', (app) => {
  const read = (file: string): string => readFileSync(join(ROOT, 'packages', app, file), 'utf8');

  const snippet = read('nginx-security-headers.conf');

  it('sets CSP, frame, content type, referrer and HSTS headers on every response', () => {
    const csp = /add_header Content-Security-Policy "([^"]+)" always;/.exec(snippet)?.[1] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src 'self'[^;]*;/);
    expect(csp).toMatch(/connect-src 'self'[^;]*;/);
    expect(/script-src ([^;]*);/.exec(csp)?.[1]).not.toContain("'unsafe-inline'");
    expect(snippet).toContain('add_header X-Frame-Options "DENY" always;');
    expect(snippet).toContain('add_header X-Content-Type-Options "nosniff" always;');
    expect(snippet).toContain(
      'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
    );
    expect(snippet).toMatch(/add_header Strict-Transport-Security "max-age=\d+" always;/);
  });

  it.each(['nginx.conf', 'nginx.dev.conf'])(
    '%s includes the headers in every location that serves the app',
    (file) => {
      const served = locations(read(file)).filter(
        (l) => /add_header|try_files|alias/.test(l.body) && !/proxy_pass/.test(l.body),
      );
      expect(served.length).toBeGreaterThanOrEqual(3);
      for (const location of served) {
        expect(location.body, location.match).toContain(`include ${SNIPPET_PATH};`);
      }
    },
  );

  it.each(['Dockerfile', 'Dockerfile.dev'])('%s installs the header snippet', (file) => {
    expect(read(file)).toContain(
      `COPY packages/${app}/nginx-security-headers.conf ${SNIPPET_PATH}`,
    );
  });

  it('index.html carries no meta CSP and no inline script', () => {
    const html = read('index.html');
    expect(html).not.toContain('Content-Security-Policy');
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\bsrc=/);
  });
});
