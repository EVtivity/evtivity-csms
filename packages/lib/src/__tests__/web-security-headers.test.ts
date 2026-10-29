// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The CSMS and portal pages are served with anti-framing, content
// type, referrer and transport headers and a CSP header (a meta CSP cannot set
// frame-ancestors). Lives in lib: the app test projects have no Node types.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
// The image installs the snippet as a template; docker-security-headers.sh
// renders it into /tmp at container start (STORAGE_IMG_SRC).
const TEMPLATE_PATH = '/etc/nginx/evtivity-security-headers.conf.template';
const SNIPPET_PATH = '/tmp/evtivity/security-headers.conf';

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

  it.each(['Dockerfile', 'Dockerfile.dev'])(
    '%s installs the header template and the script that renders it',
    (file) => {
      const dockerfile = read(file);
      expect(dockerfile).toContain(
        `COPY packages/${app}/nginx-security-headers.conf ${TEMPLATE_PATH}`,
      );
      expect(dockerfile).toMatch(
        new RegExp(
          `COPY (--chmod=755 )?packages/${app}/docker-security-headers.sh /docker-entrypoint.d/30-security-headers.sh`,
        ),
      );
    },
  );

  describe('docker-security-headers.sh', () => {
    const dir = mkdtempSync(join(tmpdir(), `evtivity-${app}-headers-`));
    const out = join(dir, 'nested', 'security-headers.conf');

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function render(storageImgSrc?: string): { status: number | null; stderr: string } {
      rmSync(out, { force: true });
      const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };
      if (storageImgSrc !== undefined) env['STORAGE_IMG_SRC'] = storageImgSrc;
      const result = spawnSync(
        'sh',
        [
          join(ROOT, 'packages', app, 'docker-security-headers.sh'),
          join(ROOT, 'packages', app, 'nginx-security-headers.conf'),
          out,
        ],
        { env, encoding: 'utf8', cwd: dir },
      );
      return { status: result.status, stderr: result.stderr };
    }

    function imgSrcOf(conf: string): string {
      const csp = /add_header Content-Security-Policy "([^"]+)" always;/.exec(conf)?.[1];
      return /img-src ([^;]*);/.exec(csp ?? '')?.[1] ?? '';
    }

    function imgSrc(): string {
      return imgSrcOf(readFileSync(out, 'utf8'));
    }

    it('keeps the template img-src without STORAGE_IMG_SRC', () => {
      const template = imgSrcOf(snippet);
      expect(template).toContain('https://*.amazonaws.com __STORAGE_IMG_SRC__ ');
      expect(render().status).toBe(0);
      expect(imgSrc()).toBe(template.replace(' __STORAGE_IMG_SRC__', ''));
      expect(render('').status).toBe(0);
      expect(imgSrc()).not.toContain('__STORAGE_IMG_SRC__');
    });

    it('adds the STORAGE_IMG_SRC origins after the AWS S3 origin', () => {
      const result = render(' https://s3.example.com  https://*.example.net http://10.0.0.5:9000 ');
      expect(result.status).toBe(0);
      expect(imgSrc()).toContain(
        'https://*.amazonaws.com https://s3.example.com https://*.example.net http://10.0.0.5:9000 ',
      );
      // The rest of the file is the template unchanged.
      expect(readFileSync(out, 'utf8').replace(/ https:\/\/s3[^;]*:9000/, '')).toBe(
        snippet.replace(' __STORAGE_IMG_SRC__', ''),
      );
    });

    it.each([
      'https://s3.example.com/bucket',
      "https://s3.example.com;script-src 'unsafe-inline'",
      'https://s3.example.com"',
      's3.example.com',
      'ftp://s3.example.com',
      'https://*',
      "'unsafe-inline'",
      'https://s3.example.com|x',
    ])('refuses %s and writes nothing', (origin) => {
      const result = render(`https://ok.example.com ${origin}`);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('STORAGE_IMG_SRC: invalid origin');
      expect(() => readFileSync(out)).toThrow();
    });
  });

  it('index.html carries no meta CSP and no inline script', () => {
    const html = read('index.html');
    expect(html).not.toContain('Content-Security-Policy');
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\bsrc=/);
  });
});
