// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OcppServer, ocppPerMessageDeflate } from '../server/ocpp-server.js';

let nextPort = 19950;
let server: OcppServer | null = null;

afterEach(async () => {
  if (server != null) {
    await server.stop();
    server = null;
  }
});

function auth(id: string): Record<string, string> {
  return { authorization: 'Basic ' + Buffer.from(`${id}:password`).toString('base64') };
}

// The extension the server accepted, as the client sees it after the handshake.
function negotiated(url: string, id: string, options: WebSocket.ClientOptions = {}) {
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url, ['ocpp2.1'], { ...options, headers: auth(id) });
    ws.on('open', () => {
      const extensions = ws.extensions;
      ws.close();
      resolve(extensions);
    });
    ws.on('error', reject);
  });
}

describe('ocppPerMessageDeflate', () => {
  it('uses the plan options when on and nothing when off', () => {
    expect(ocppPerMessageDeflate(true)).toEqual({
      threshold: 1024,
      serverNoContextTakeover: true,
      clientNoContextTakeover: false,
      zlibDeflateOptions: { memLevel: 5 },
      concurrencyLimit: 10,
    });
    expect(ocppPerMessageDeflate(false)).toBe(false);
  });
});

describe('OcppServer permessage-deflate', () => {
  it('negotiates permessage-deflate on the plain listener by default', async () => {
    const port = nextPort++;
    server = new OcppServer();
    await server.start({ port, host: '127.0.0.1' });
    const ext = await negotiated(`ws://127.0.0.1:${String(port)}/DEFLATE-1`, 'DEFLATE-1');
    expect(ext).toContain('permessage-deflate');
  });

  it('accepts no extension when compression is off', async () => {
    const port = nextPort++;
    server = new OcppServer({ wsCompression: false });
    await server.start({ port, host: '127.0.0.1' });
    const ext = await negotiated(`ws://127.0.0.1:${String(port)}/DEFLATE-2`, 'DEFLATE-2');
    expect(ext).toBe('');
  });

  it('negotiates permessage-deflate on the TLS listener', async () => {
    const certDir = mkdtempSync(join(tmpdir(), 'ocpp-deflate-'));
    try {
      const keyPath = join(certDir, 'key.pem');
      const certPath = join(certDir, 'cert.pem');
      try {
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-days',
            '1',
            '-subj',
            '/CN=127.0.0.1',
            '-addext',
            'subjectAltName=IP:127.0.0.1',
          ],
          { stdio: 'ignore' },
        );
      } catch {
        // fail-open: no openssl in this environment; the plain listener test covers the option.
        return;
      }
      const port = nextPort++;
      const tlsPort = nextPort++;
      server = new OcppServer();
      await server.start({
        port,
        host: '127.0.0.1',
        tls: {
          cert: readFileSync(certPath, 'utf-8'),
          key: readFileSync(keyPath, 'utf-8'),
          port: tlsPort,
        },
      });
      const ext = await negotiated(`wss://127.0.0.1:${String(tlsPort)}/DEFLATE-3`, 'DEFLATE-3', {
        ca: readFileSync(certPath),
      });
      expect(ext).toContain('permessage-deflate');
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});
