// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// HTTP and HTTPS upload receiver for the local Docker Compose stack (dev tools). Simulator
// stations upload their logs here (GetLog, GetDiagnostics) the way a station uploads to an
// operator's log server, and the local file transfer check reads them back. Files are kept
// in memory only (the newest MAX_FILES).
//
//   PUT  /upload/<name>       store a file (OCPP 2.1 N01.FR.18); POST works too
//   GET  /files               list stored files (name, size, method, receivedAt)
//   GET  /files/<name>        the stored file (also serves as a firmware download)
//   DELETE /files             delete every stored file
//   any  /redirect/<path>     302 to /upload/<path> (a station must not follow it, N01.FR.30)
//   GET  /health              200 when running (no authentication)
//
// Every route but /health needs HTTP Basic authentication with FILE_RECEIVER_USER and
// FILE_RECEIVER_PASSWORD (dev-only values). HTTPS uses a self-signed certificate made at
// start for the names file-receiver and localhost (stations accept it with
// TLS_REJECT_UNAUTHORIZED=false, as the Compose simulator runs). No dependencies: it runs
// on the plain node image.

import { createHash, generateKeyPairSync, sign, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';

const PORT = Number(process.env.PORT ?? 8080);
const TLS_PORT = Number(process.env.TLS_PORT ?? 8443);
const USER = process.env.FILE_RECEIVER_USER ?? 'evtivity';
const PASSWORD = process.env.FILE_RECEIVER_PASSWORD ?? 'evtivity';
const MAX_FILES = Number(process.env.MAX_FILES ?? 500);
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** @type {Map<string, { body: Buffer, method: string, receivedAt: string }>} */
const files = new Map();

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sameSecret(a, b) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function authorized(req) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  return (
    sameSecret(decoded.slice(0, colon), USER) && sameSecret(decoded.slice(colon + 1), PASSWORD)
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// A POST (N01.FR.19) names the file in Content-Disposition; a multipart body holds it in
// its first part.
function postedFile(req, body, fallbackName) {
  const type = req.headers['content-type'] ?? '';
  const boundary = /boundary=("?)([^";]+)\1/.exec(type)?.[2];
  if (type.startsWith('multipart/form-data') && boundary != null) {
    const text = body.toString('latin1');
    const start = text.indexOf(`--${boundary}`);
    const headersEnd = text.indexOf('\r\n\r\n', start);
    const end = text.indexOf(`\r\n--${boundary}`, headersEnd);
    if (start >= 0 && headersEnd > 0 && end > headersEnd) {
      const name = /filename="([^"]+)"/.exec(text.slice(start, headersEnd))?.[1];
      return { name: name ?? fallbackName, body: body.subarray(headersEnd + 4, end) };
    }
  }
  const name = /filename="([^"]+)"/.exec(req.headers['content-disposition'] ?? '')?.[1];
  return { name: name ?? fallbackName, body };
}

function store(name, body, method) {
  if (files.size >= MAX_FILES && !files.has(name)) {
    const oldest = files.keys().next().value;
    if (oldest != null) files.delete(oldest);
  }
  files.set(name, { body, method, receivedAt: new Date().toISOString() });
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://file-receiver');
  const path = url.pathname;
  if (req.method === 'GET' && path === '/health') {
    json(res, 200, { status: 'ok', files: files.size });
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="file-receiver"' });
    res.end();
    return;
  }
  if (path.startsWith('/redirect/')) {
    req.resume();
    res.writeHead(302, { Location: `/upload/${path.slice('/redirect/'.length)}` });
    res.end();
    return;
  }
  if (path.startsWith('/upload/') && (req.method === 'PUT' || req.method === 'POST')) {
    const urlName = decodeURIComponent(path.slice('/upload/'.length));
    const body = await readBody(req);
    const file = req.method === 'POST' ? postedFile(req, body, urlName) : { name: urlName, body };
    if (!NAME.test(file.name)) {
      json(res, 400, { error: 'invalid file name' });
      return;
    }
    store(file.name, file.body, req.method);
    json(res, 201, { name: file.name, size: file.body.length });
    return;
  }
  if (path === '/files' && req.method === 'GET') {
    json(
      res,
      200,
      [...files].map(([name, f]) => ({
        name,
        size: f.body.length,
        method: f.method,
        receivedAt: f.receivedAt,
      })),
    );
    return;
  }
  if (path === '/files' && req.method === 'DELETE') {
    files.clear();
    res.writeHead(204);
    res.end();
    return;
  }
  if (path.startsWith('/files/') && req.method === 'GET') {
    const file = files.get(decodeURIComponent(path.slice('/files/'.length)));
    if (file == null) {
      json(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': file.body.length,
    });
    res.end(file.body);
    return;
  }
  json(res, 404, { error: 'not found' });
}

function onRequest(req, res) {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, err?.status ?? 500, { error: err?.message ?? 'error' });
    else res.destroy();
  });
}

// ---------------------------------------------------------------- self-signed certificate

// DER encoding of the few ASN.1 types a self-signed X.509 v3 certificate needs.
function der(tag, content) {
  const len = content.length;
  let header;
  if (len < 0x80) header = Buffer.from([tag, len]);
  else if (len < 0x100) header = Buffer.from([tag, 0x81, len]);
  else header = Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
  return Buffer.concat([header, content]);
}
const seq = (...parts) => der(0x30, Buffer.concat(parts));
const oid = (bytes) => der(0x06, Buffer.from(bytes));
const utcTime = (date) =>
  der(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-T:]/g, '')}Z`));

function selfSignedCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaSha256 = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  const name = seq(
    der(0x31, seq(oid([0x55, 0x04, 0x03]), der(0x0c, Buffer.from('file-receiver')))),
  );
  const now = Date.now();
  const altNames = seq(
    der(0x82, Buffer.from('file-receiver')),
    der(0x82, Buffer.from('localhost')),
    der(0x87, Buffer.from([127, 0, 0, 1])),
  );
  const extensions = der(0xa3, seq(seq(oid([0x55, 0x1d, 0x11]), der(0x04, altNames))));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([0x01, ...Buffer.from(String(now)).subarray(0, 8)])),
    ecdsaSha256,
    name,
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 365 * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('sha256', tbs, privateKey);
  const cert = seq(tbs, ecdsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd()}\n-----END CERTIFICATE-----\n`;
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { cert: pem, key };
}

createServer(onRequest).listen(PORT, () => {
  console.log(`file-receiver listening on ${PORT} (http)`);
});
createTlsServer(selfSignedCertificate(), onRequest).listen(TLS_PORT, () => {
  console.log(`file-receiver listening on ${TLS_PORT} (https)`);
});
