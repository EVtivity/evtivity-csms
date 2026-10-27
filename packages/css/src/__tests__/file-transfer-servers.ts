// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// In-process test servers for the simulator's file transfers: a small FTP server (passive
// mode, optional explicit TLS: AUTH TLS, PROT P) and an SFTP server built on ssh2's Server.
// Both keep files in memory and accept one user and password.

import crypto, { webcrypto } from 'node:crypto';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import type { Server as NetServer } from 'node:net';
import tls from 'node:tls';
import * as x509 from '@peculiar/x509';
import ssh2 from 'ssh2';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

export interface TestCert {
  cert: string;
  key: string;
}

/** A self-signed certificate for 127.0.0.1 (trusted only when passed as a CA). */
export async function selfSignedCert(): Promise<TestCert> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=127.0.0.1',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: ALG,
    keys,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: '127.0.0.1' }])],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const key = crypto
    .createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' });
  return { cert: cert.toString('pem'), key };
}

export interface TestFileServer {
  port: number;
  files: Map<string, Buffer>;
  commands: string[];
  /** SFTP only: the OpenSSH SHA-256 fingerprint of the server's host key. */
  hostKeySha256?: string;
  close(): Promise<void>;
}

function listen(server: NetServer, sockets: Set<Socket>): Promise<number> {
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeAll(servers: NetServer[], sockets: Set<Socket>): Promise<void> {
  for (const s of sockets) s.destroy();
  return Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  ).then(() => undefined);
}

/**
 * A minimal FTP server: USER/PASS, EPSV and PASV, STOR, RETR. With `tlsCert` it also
 * answers AUTH TLS and PROT P (explicit FTPS).
 */
export async function startFtpServer(opts: {
  user: string;
  password: string;
  tlsCert?: TestCert;
}): Promise<TestFileServer> {
  const files = new Map<string, Buffer>();
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const servers: NetServer[] = [];
  const secureContext =
    opts.tlsCert != null ? tls.createSecureContext({ ...opts.tlsCert }) : undefined;

  const control = createNetServer((raw) => {
    let socket: Socket = raw;
    let user = '';
    let loggedIn = false;
    let protP = false;
    let data: Promise<Socket> | null = null;
    let buffered = '';
    const reply = (line: string): void => {
      socket.write(`${line}\r\n`);
    };

    const openPassive = async (): Promise<number> => {
      const dataServer = createNetServer();
      servers.push(dataServer);
      const port = await listen(dataServer, sockets);
      data = new Promise<Socket>((resolve) => {
        dataServer.once('connection', (s: Socket) => {
          if (!protP || secureContext == null) {
            resolve(s);
            return;
          }
          const secure = new tls.TLSSocket(s, { isServer: true, secureContext });
          secure.once('secure', () => resolve(secure));
        });
      });
      return port;
    };

    const handle = async (line: string): Promise<void> => {
      const [rawCmd = '', ...rest] = line.split(' ');
      const cmd = rawCmd.toUpperCase();
      const arg = rest.join(' ');
      commands.push(cmd === 'PASS' ? 'PASS ***' : line);
      switch (cmd) {
        case 'AUTH':
          if (secureContext == null) {
            reply('502 TLS not available');
            return;
          }
          reply('234 Using TLS');
          socket.removeAllListeners('data');
          socket = new tls.TLSSocket(socket, { isServer: true, secureContext });
          socket.on('data', onData);
          return;
        case 'USER':
          user = arg;
          reply('331 Password required');
          return;
        case 'PASS':
          loggedIn = user === opts.user && arg === opts.password;
          reply(loggedIn ? '230 Logged in' : '530 Login incorrect');
          return;
        case 'PROT':
          protP = arg.toUpperCase() === 'P';
          reply('200 Ok');
          return;
        case 'QUIT':
          reply('221 Bye');
          socket.end();
          return;
      }
      if (!loggedIn && cmd !== 'FEAT' && cmd !== 'PBSZ' && cmd !== 'OPTS') {
        reply('530 Not logged in');
        return;
      }
      switch (cmd) {
        case 'FEAT':
          reply('211-Features');
          reply(' EPSV');
          reply('211 End');
          return;
        case 'PWD':
          reply('257 "/"');
          return;
        case 'EPSV':
          reply(`229 Entering Extended Passive Mode (|||${String(await openPassive())}|)`);
          return;
        case 'PASV': {
          const port = await openPassive();
          reply(`227 Entering Passive Mode (127,0,0,1,${String(port >> 8)},${String(port & 255)})`);
          return;
        }
        case 'STOR': {
          const pending = data;
          if (pending == null) {
            reply('425 No data connection');
            return;
          }
          reply('150 Ok to send data');
          const s = await pending;
          const chunks: Buffer[] = [];
          s.on('data', (c: Buffer) => chunks.push(c));
          await new Promise<void>((resolve) => s.on('end', () => resolve()));
          s.end();
          files.set(arg, Buffer.concat(chunks));
          data = null;
          reply('226 Transfer complete');
          return;
        }
        case 'RETR': {
          const file = files.get(arg);
          const pending = data;
          if (file == null || pending == null) {
            reply('550 No such file');
            return;
          }
          reply('150 Opening data connection');
          const s = await pending;
          await new Promise<void>((resolve) => s.end(file, () => resolve()));
          data = null;
          reply('226 Transfer complete');
          return;
        }
        default:
          // TYPE, STRU, OPTS, PBSZ and anything else the client sends to set up.
          reply('200 Ok');
      }
    };

    let queue = Promise.resolve();
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      let index: number;
      while ((index = buffered.indexOf('\r\n')) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        queue = queue.then(() => handle(line));
      }
    };
    socket.on('data', onData);
    reply('220 Test FTP server');
  });
  servers.push(control);
  const port = await listen(control, sockets);
  return { port, files, commands, close: () => closeAll(servers, sockets) };
}

/** An SFTP server: password authentication; a path under /denied answers PERMISSION_DENIED. */
export async function startSftpServer(opts: {
  user: string;
  password: string;
}): Promise<TestFileServer> {
  const { Server, utils } = ssh2;
  const { STATUS_CODE } = utils.sftp;
  const files = new Map<string, Buffer>();
  const commands: string[] = [];
  const keyPair = utils.generateKeyPairSync('ed25519');
  const hostKey = keyPair.private;
  const parsed = utils.parseKey(keyPair.public);
  if (parsed instanceof Error) throw parsed;
  const hostKeySha256 = crypto
    .createHash('sha256')
    .update(parsed.getPublicSSH())
    .digest('base64')
    .replace(/=+$/, '');

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (
        ctx.method === 'password' &&
        ctx.username === opts.user &&
        ctx.password === opts.password
      ) {
        ctx.accept();
      } else {
        ctx.reject(['password']);
      }
    });
    client.on('error', () => {
      // fail-open: a client that disconnects mid-handshake ends its own session
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<string, { path: string; chunks: Buffer[]; read: boolean }>();
          let next = 0;
          sftp.on('OPEN', (reqid, filename, flags) => {
            commands.push(`OPEN ${filename}`);
            if (filename.startsWith('/denied')) {
              sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
              return;
            }
            const read = (flags & utils.sftp.OPEN_MODE.READ) !== 0;
            if (read && !files.has(filename)) {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              return;
            }
            const handle = Buffer.from(String(next++));
            handles.set(handle.toString(), { path: filename, chunks: [], read });
            sftp.handle(reqid, handle);
          });
          sftp.on('WRITE', (reqid, handle, _offset, chunk) => {
            handles.get(handle.toString())?.chunks.push(Buffer.from(chunk));
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on('READ', (reqid, handle, offset, length) => {
            const entry = handles.get(handle.toString());
            const file = entry != null ? files.get(entry.path) : undefined;
            if (file == null || offset >= file.length) {
              sftp.status(reqid, STATUS_CODE.EOF);
              return;
            }
            sftp.data(reqid, file.subarray(offset, offset + length));
          });
          sftp.on('FSTAT', (reqid, handle) => {
            const entry = handles.get(handle.toString());
            const file = entry != null ? files.get(entry.path) : undefined;
            sftp.attrs(reqid, {
              mode: 0o100644,
              uid: 0,
              gid: 0,
              size: file?.length ?? 0,
              atime: 0,
              mtime: 0,
            });
          });
          sftp.on('CLOSE', (reqid, handle) => {
            const entry = handles.get(handle.toString());
            if (entry != null && !entry.read) files.set(entry.path, Buffer.concat(entry.chunks));
            handles.delete(handle.toString());
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
  });
  const clients = new Set<ssh2.Connection>();
  server.on('connection', (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  const close = (): Promise<void> => {
    for (const client of clients) client.end();
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return { port, files, commands, hostKeySha256, close };
}
