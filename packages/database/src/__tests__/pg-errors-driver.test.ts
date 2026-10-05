// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The errors postgres.js itself raises when a connection fails, against local
// sockets (no database needed), so the classifier matches the real driver.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import postgres from 'postgres';
import { connectionName } from '@evtivity/lib';
import { pgConnectionErrorKind } from '../lib/pg-errors.js';

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

// A TCP server on a free local port that handles each connection with `onSocket`.
async function listen(onSocket: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer((socket) => {
    sockets.push(socket);
    onSocket(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as net.AddressInfo).port;
}

async function queryError(port: number): Promise<unknown> {
  const sql = postgres(`postgres://evtivity:evtivity@127.0.0.1:${String(port)}/evtivity`, {
    connection: { application_name: connectionName() },
    connect_timeout: 1,
    // No type lookup after the startup, so the test statement is the first one sent.
    fetch_types: false,
    max: 1,
    onnotice: () => {},
  });
  try {
    await sql`SELECT 1`;
    return null;
  } catch (err) {
    return err;
  } finally {
    await sql.end({ timeout: 0 });
  }
}

describe('pgConnectionErrorKind on real postgres.js errors', () => {
  it('a server that never answers the startup is CONNECT_TIMEOUT: not sent', async () => {
    const port = await listen(() => undefined);
    const err = await queryError(port);
    expect((err as { code?: string }).code).toBe('CONNECT_TIMEOUT');
    expect(pgConnectionErrorKind(err)).toBe('not-sent');
  });

  it('a refused connection is not sent', async () => {
    // Take a free port, then close it so nothing listens there.
    const port = await listen(() => undefined);
    await new Promise<void>((resolve) => {
      servers.pop()?.close(() => {
        resolve();
      });
    });
    const err = await queryError(port);
    expect((err as { code?: string }).code).toBe('ECONNREFUSED');
    expect(pgConnectionErrorKind(err)).toBe('not-sent');
  });

  it('a server that drops an open connection during a statement is interrupted', async () => {
    // Accepts the startup (AuthenticationOk, ReadyForQuery idle), then closes
    // the connection when the statement arrives.
    const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
    const readyForQuery = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
    const port = await listen((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.concat([authOk, readyForQuery]));
        socket.once('data', () => {
          socket.destroy();
        });
      });
    });
    const err = await queryError(port);
    expect((err as { code?: string }).code).toBe('CONNECTION_CLOSED');
    expect(pgConnectionErrorKind(err)).toBe('interrupted');
  });
});
