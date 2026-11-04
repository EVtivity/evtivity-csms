// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Opt-in run of R2ObjectStorage against a real Cloudflare R2 bucket. Skipped
// unless R2_LIVE_ENDPOINT (the bucket's S3 API URL), R2_LIVE_BUCKET,
// R2_LIVE_ACCESS_KEY_ID and R2_LIVE_SECRET_ACCESS_KEY are set. A token scoped
// to the one bucket (Object Read & Write) is enough. Everything it writes is
// under r2-live-test/<run>/ and deleted at the end. It prints statuses and
// error codes only, never a key or a presigned URL.
//
// It is the evidence that a presigned PUT is bounded on R2: the upload URL
// signs Content-Length and Content-Type, and R2 refuses a body of any other
// length (declared, chunked, or smaller) or type. Bytes past the signed
// Content-Length never become part of the object.

import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { R2ObjectStorage, createR2Client, validateR2Endpoint } from '../storage/index.js';

const endpointSetting = process.env['R2_LIVE_ENDPOINT'] ?? '';
const bucket = process.env['R2_LIVE_BUCKET'] ?? '';
const accessKeyId = process.env['R2_LIVE_ACCESS_KEY_ID'] ?? '';
const secretAccessKey = process.env['R2_LIVE_SECRET_ACCESS_KEY'] ?? '';
const live =
  endpointSetting !== '' && bucket !== '' && accessKeyId !== '' && secretAccessKey !== '';
const TIMEOUT_MS = 60_000;

const SIZE = 1024;
const TYPE = 'image/png';
const PREFIX = `r2-live-test/${randomUUID()}/`;

function report(message: string): void {
  // Statuses and error codes only.
  console.info(`[r2-live] ${message}`);
}

interface Sent {
  status: number;
  code: string;
}

function errorCode(body: string): string {
  return /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? '';
}

/** One HTTP/1.1 PUT with exactly these headers and body chunks. */
function put(url: string, headers: Record<string, string | number>, chunks: Buffer[]) {
  return new Promise<Sent>((resolve, reject) => {
    const req = httpsRequest(url, { method: 'PUT', headers }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, code: errorCode(body) }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

/** Raw TLS: a Content-Length of SIZE, then `extra` more bytes on the wire. */
function putPastContentLength(url: string, extra: number) {
  const target = new URL(url);
  return new Promise<Sent>((resolve, reject) => {
    const socket = tlsConnect({
      host: target.hostname,
      port: 443,
      servername: target.hostname,
      ALPNProtocols: ['http/1.1'],
    });
    let response = '';
    socket.on('secureConnect', () => {
      socket.write(
        `PUT ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\n` +
          `Content-Type: ${TYPE}\r\nContent-Length: ${String(SIZE)}\r\nConnection: close\r\n\r\n`,
      );
      socket.write(randomBytes(SIZE + extra));
    });
    socket.on('data', (d: Buffer) => (response += d.toString()));
    socket.on('end', () =>
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1] ?? 0),
        code: errorCode(response),
      }),
    );
    socket.on('error', reject);
    socket.setTimeout(15_000, () => socket.destroy(new Error('timeout')));
  });
}

/** The protocol R2 picks when a client offers HTTP/2 and HTTP/1.1. */
function negotiatedProtocol(host: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = tlsConnect(
      { host, port: 443, servername: host, ALPNProtocols: ['h2', 'http/1.1'] },
      () => {
        resolve(typeof socket.alpnProtocol === 'string' ? socket.alpnProtocol : 'none');
        socket.end();
      },
    );
    socket.on('error', reject);
  });
}

describe.skipIf(!live)('Cloudflare R2 (live)', () => {
  const endpoint = validateR2Endpoint(endpointSetting);
  const client = createR2Client({
    endpoint: endpoint ?? 'https://invalid.example',
    bucket,
    accessKeyId,
    secretAccessKey,
  });
  const storage = new R2ObjectStorage(client, bucket);

  /** What R2 stored under `key`, or null for nothing. */
  async function stored(key: string): Promise<{ size: number; type: string } | null> {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: head.ContentLength ?? -1, type: head.ContentType ?? '' };
    } catch {
      return null;
    }
  }

  /** A fresh upload URL for SIZE bytes of TYPE, and the key it writes. */
  async function upload(name: string): Promise<{ key: string; url: string }> {
    const key = `${PREFIX}${name}`;
    const target = await storage.createUpload(key, TYPE, { size: SIZE, maxBytes: SIZE });
    if (target.method !== 'PUT') throw new Error('R2 uploads with a PUT');
    expect(target.headers).toEqual({ 'Content-Type': TYPE });
    return { key, url: target.url };
  }

  afterAll(async () => {
    if (endpoint == null) return;
    const deleted = await storage.deleteObjectsUnderPrefix(bucket, PREFIX);
    report(`cleanup deleted ${String(deleted)} object(s)`);
    client.destroy();
  }, TIMEOUT_MS);

  it(
    'takes the S3 API URL and reaches the bucket with the token',
    async () => {
      expect(endpoint).not.toBeNull();
      await storage.testConnection();
    },
    TIMEOUT_MS,
  );

  it(
    'signs Content-Length and Content-Type and no checksum',
    async () => {
      const { url } = await upload('signed');
      const params = new URL(url).searchParams;
      expect(params.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
      expect([...params.keys()].filter((k) => /checksum/i.test(k))).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'stores an upload of exactly the signed size and type',
    async () => {
      const { key, url } = await upload('exact');
      const sent = await put(url, { 'Content-Type': TYPE, 'Content-Length': SIZE }, [
        randomBytes(SIZE),
      ]);
      report(`exact: ${String(sent.status)}`);
      expect(sent.status).toBe(200);
      expect(await stored(key)).toEqual({ size: SIZE, type: TYPE });
    },
    TIMEOUT_MS,
  );

  it.each([
    ['one byte more', SIZE + 1],
    ['10 MB', 10 * 1024 * 1024],
    ['one byte less', SIZE - 1],
  ])(
    'refuses a body of %s with its own Content-Length',
    async (_, length) => {
      const { key, url } = await upload(`length-${String(length)}`);
      const sent = await put(url, { 'Content-Type': TYPE, 'Content-Length': length }, [
        randomBytes(length),
      ]);
      report(`${String(length)} bytes: ${String(sent.status)} ${sent.code}`);
      expect(sent.status).toBe(403);
      expect(sent.code).toBe('SignatureDoesNotMatch');
      expect(await stored(key)).toBeNull();
    },
    TIMEOUT_MS,
  );

  it(
    'refuses a chunked body over the signed size without Content-Length',
    async () => {
      const { key, url } = await upload('chunked-over');
      const body = randomBytes(SIZE + 1);
      const sent = await put(url, { 'Content-Type': TYPE, 'Transfer-Encoding': 'chunked' }, [
        body.subarray(0, 600),
        body.subarray(600),
      ]);
      report(`chunked ${String(SIZE + 1)} bytes: ${String(sent.status)} ${sent.code}`);
      expect(sent.status).toBe(403);
      expect(await stored(key)).toBeNull();
    },
    TIMEOUT_MS,
  );

  it(
    'stores no more than the signed size from a chunked body',
    async () => {
      const { key, url } = await upload('chunked-exact');
      const body = randomBytes(SIZE);
      const sent = await put(url, { 'Content-Type': TYPE, 'Transfer-Encoding': 'chunked' }, [
        body.subarray(0, 600),
        body.subarray(600),
      ]);
      report(`chunked ${String(SIZE)} bytes: ${String(sent.status)} ${sent.code}`);
      const object = await stored(key);
      if (object != null) expect(object).toEqual({ size: SIZE, type: TYPE });
    },
    TIMEOUT_MS,
  );

  it(
    'stores no more than the signed size when more bytes follow on the wire',
    async () => {
      const { key, url } = await upload('overrun');
      const sent = await putPastContentLength(url, 512);
      report(`Content-Length ${String(SIZE)} + 512 bytes: ${String(sent.status)} ${sent.code}`);
      const object = await stored(key);
      if (object != null) expect(object).toEqual({ size: SIZE, type: TYPE });
    },
    TIMEOUT_MS,
  );

  it.each([
    ['another type', { 'Content-Type': 'text/html' }],
    ['no type', {}],
  ])(
    'refuses %s',
    async (_, typeHeader) => {
      const { key, url } = await upload(`type-${String(Object.keys(typeHeader).length)}`);
      const sent = await put(url, { ...typeHeader, 'Content-Length': SIZE }, [randomBytes(SIZE)]);
      report(`type ${JSON.stringify(typeHeader)}: ${String(sent.status)} ${sent.code}`);
      expect(sent.status).toBe(403);
      expect(await stored(key)).toBeNull();
    },
    TIMEOUT_MS,
  );

  it(
    'offers no HTTP/2, so a request without Content-Length always comes chunked',
    async () => {
      const protocol = await negotiatedProtocol(new URL(endpoint ?? '').hostname);
      report(`ALPN: ${protocol}`);
      // HTTP/2 lets a body end without a Content-Length; if R2 starts to offer
      // it, this test must grow an HTTP/2 case before the result still holds.
      expect(protocol).toBe('http/1.1');
    },
    TIMEOUT_MS,
  );

  it(
    'reads, presigns a GET, writes and deletes through the S3 API',
    async () => {
      const key = `${PREFIX}api/object.txt`;
      await storage.putObject(bucket, key, Buffer.from('hello r2'), 'text/plain');
      const read = await storage.readObject(bucket, key, 1024);
      expect(read).toMatchObject({ status: 'ok', contentType: 'text/plain' });
      if (read.status === 'ok') expect(read.bytes.toString()).toBe('hello r2');
      expect(await storage.readObject(bucket, key, 3)).toMatchObject({ status: 'too_large' });

      const download = await storage.getDownloadUrl(bucket, key, {
        fileName: 'object.txt',
        contentType: 'text/plain',
      });
      const res = await fetch(download);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('attachment');
      expect(await res.text()).toBe('hello r2');

      await storage.deleteObject(bucket, key);
      expect(await storage.readObject(bucket, key, 1024)).toEqual({ status: 'missing' });

      // The batch delete (DeleteObjects needs a checksum even with WHEN_REQUIRED).
      await storage.putObject(bucket, `${PREFIX}batch/a`, Buffer.from('a'), 'text/plain');
      await storage.putObject(bucket, `${PREFIX}batch/b`, Buffer.from('b'), 'text/plain');
      expect(await storage.deleteObjectsUnderPrefix(bucket, `${PREFIX}batch/`)).toBe(2);
      expect(await stored(`${PREFIX}batch/a`)).toBeNull();
    },
    TIMEOUT_MS,
  );
});
