// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Notification test sink for the local Docker Compose stack (dev tools). The
// api, ocpp and worker send driver SMS and push here instead of Twilio and
// Expo when NOTIFICATIONS_ALLOW_TEST_SINK=true and NOTIFICATIONS_TEST_SINK_URL
// point at it. Messages are kept in memory only (the newest MAX_MESSAGES).
//
//   POST   /messages   store one message (JSON, sent by the CSMS)
//   GET    /messages   list stored messages, oldest first
//                      filters: to, channel (sms|push), eventType, language,
//                      after (return only ids above this one), limit
//   DELETE /messages   delete stored messages (same to and channel filters)
//   GET    /health     200 when running
//
// No dependencies: it runs on the plain node image.

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES ?? 10000);
const MAX_BODY_BYTES = 1024 * 1024;
const CHANNELS = new Set(['sms', 'push']);

/** @type {Array<Record<string, unknown>>} */
let messages = [];
let nextId = 1;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function optionalString(value) {
  return typeof value === 'string' ? value : null;
}

function matches(message, query) {
  for (const key of ['to', 'channel', 'eventType', 'language']) {
    const wanted = query.get(key);
    if (wanted != null && message[key] !== wanted) return false;
  }
  const after = query.get('after');
  if (after != null && !(message.id > Number(after))) return false;
  return true;
}

async function store(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (err) {
    send(res, 400, { error: `invalid JSON body: ${err.message}` });
    return;
  }
  if (parsed == null || typeof parsed !== 'object') {
    send(res, 400, { error: 'body must be a JSON object' });
    return;
  }
  if (!CHANNELS.has(parsed.channel) || typeof parsed.to !== 'string') {
    send(res, 400, { error: 'channel (sms or push) and to are required' });
    return;
  }
  if (typeof parsed.body !== 'string') {
    send(res, 400, { error: 'body is required' });
    return;
  }
  const message = {
    id: nextId++,
    receivedAt: new Date().toISOString(),
    channel: parsed.channel,
    to: parsed.to,
    eventType: optionalString(parsed.eventType),
    language: optionalString(parsed.language),
    title: optionalString(parsed.title),
    body: parsed.body,
    data: parsed.data != null && typeof parsed.data === 'object' ? parsed.data : null,
  };
  messages.push(message);
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
  send(res, 201, { id: message.id });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://notify-sink');
  if (url.pathname === '/health' && req.method === 'GET') {
    send(res, 200, { status: 'ok', messages: messages.length });
    return;
  }
  if (url.pathname !== '/messages') {
    send(res, 404, { error: 'not found' });
    return;
  }
  if (req.method === 'POST') {
    store(req, res).catch((err) => send(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET') {
    let found = messages.filter((m) => matches(m, url.searchParams));
    const limit = Number(url.searchParams.get('limit') ?? 0);
    if (limit > 0) found = found.slice(-limit);
    send(res, 200, { messages: found });
    return;
  }
  if (req.method === 'DELETE') {
    const before = messages.length;
    messages = messages.filter((m) => !matches(m, url.searchParams));
    send(res, 200, { deleted: before - messages.length });
    return;
  }
  send(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, () => {
  console.log(`notify-sink listening on ${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
