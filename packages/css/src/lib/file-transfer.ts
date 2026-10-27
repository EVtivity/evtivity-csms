// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Station file transfers of the simulator: log and diagnostics uploads (OCPP 2.1 N01 GetLog,
// 1.6 GetDiagnostics and the Security Whitepaper GetLog) and firmware downloads, over
// HTTP(S), FTP, FTPS (explicit TLS) and SFTP. The URL comes from the CSMS, so every
// connection goes to an address the SSRF guard of @evtivity/lib allows: unroutable and cloud
// metadata addresses are always refused, and loopback and private addresses only when the
// caller allows private networks (development and test) or names the host in
// `allowedPrivateHosts`. Downloads are read up to a size cap, every transfer ends at a
// timeout, and an SFTP server must present the expected host key unless verification is off.

import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable, Writable } from 'node:stream';
import tls from 'node:tls';
import { Client as FtpClient, FTPError } from 'basic-ftp';
import type { AccessOptions } from 'basic-ftp';
import { Client as SshClient } from 'ssh2';
import type { ConnectConfig, SFTPWrapper } from 'ssh2';
import {
  BlockedDestinationError,
  blockedDestinationOf,
  createGuardedLookup,
  isNonPublicAddress,
  isUnroutableAddress,
  readCappedBody,
  ResponseTooLargeError,
  safeFetch,
} from '@evtivity/lib';
import { logger } from './logger.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export type FileTransferFailure =
  | 'InvalidUrl'
  | 'UnsupportedProtocol'
  | 'BlockedDestination'
  | 'PermissionDenied'
  | 'RedirectNotAllowed'
  | 'TooLarge'
  | 'UntrustedHostKey'
  | 'Canceled'
  | 'TransferFailed';

export class FileTransferError extends Error {
  constructor(
    readonly reason: FileTransferFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FileTransferError';
  }
}

export interface FileTransferOptions {
  /** Ends the whole transfer after this time (default 60 s). */
  timeoutMs?: number;
  /** Cancels the transfer (a new GetLog replaces the running upload, N01.FR.12). */
  signal?: AbortSignal;
  /** A CA (PEM) trusted for https and ftps next to the system roots (N01.FR.15/16). */
  caPem?: string;
  /**
   * Verify the server: the certificate of https and ftps, the host key of sftp against
   * `sftpHostKeySha256` (default true).
   */
  rejectUnauthorized?: boolean;
  /**
   * The SHA-256 fingerprint of the SFTP server's host key, as OpenSSH prints it
   * (`SHA256:<base64>`, the prefix and the base64 padding optional). Required for sftp while
   * `rejectUnauthorized` is on: without it, or on a mismatch, the transfer fails closed.
   */
  sftpHostKeySha256?: string;
  /** Allow loopback and private addresses for every host (development and test only). */
  allowPrivateNetworks?: boolean;
  /** Hosts (`host` or `host:port`, case-insensitive) that may be on a private address. */
  allowedPrivateHosts?: readonly string[];
}

function defaultPort(url: URL): number {
  switch (url.protocol) {
    case 'https:':
      return 443;
    case 'ftp:':
    case 'ftps:':
      return 21;
    case 'sftp:':
      return 22;
    default:
      return 80;
  }
}

/** Whether `url` may reach a loopback or private address (never an unroutable one). */
function privateAllowed(url: URL, options: FileTransferOptions): boolean {
  if (options.allowPrivateNetworks === true) return true;
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const port = url.port !== '' ? Number(url.port) : defaultPort(url);
  return (options.allowedPrivateHosts ?? []).some((entry) => {
    const allowed = entry.trim().toLowerCase();
    return allowed === host || allowed === `${host}:${String(port)}`;
  });
}

/**
 * The URL a file is uploaded to: a location ending with "/" gets the file name appended
 * (OCPP 2.1 N01.FR.21), any other location is used as received (N01.FR.29). The same rule
 * serves the 1.6 GetDiagnostics location.
 */
export function uploadTargetUrl(location: string, fileName: string): URL {
  const target = location.endsWith('/') ? location + encodeURIComponent(fileName) : location;
  const url = URL.parse(target);
  if (url == null) throw new FileTransferError('InvalidUrl', 'The location is not a URL');
  return url;
}

/** Uploads `body` to `location` (with `fileName` appended to a location ending with "/"). */
export async function uploadFile(
  location: string,
  fileName: string,
  body: Buffer,
  options: FileTransferOptions = {},
): Promise<void> {
  const url = uploadTargetUrl(location, fileName);
  const signal = transferSignal(options);
  switch (url.protocol) {
    case 'http:':
    case 'https:':
      return httpUpload(url, body, options, signal);
    case 'ftp:':
    case 'ftps:':
      return withFtp(url, options, signal, async (client, path) => {
        await client.uploadFrom(Readable.from(body), path);
      });
    case 'sftp:':
      return withSftp(url, options, signal, (sftp, path) => sftpWrite(sftp, path, body));
    default:
      throw new FileTransferError('UnsupportedProtocol', `${url.protocol} is not supported`);
  }
}

/** Downloads `location`, refusing a file larger than `maxBytes`. */
export async function downloadFile(
  location: string,
  maxBytes: number,
  options: FileTransferOptions = {},
): Promise<Buffer> {
  const url = URL.parse(location);
  if (url == null) throw new FileTransferError('InvalidUrl', 'The location is not a URL');
  const signal = transferSignal(options);
  switch (url.protocol) {
    case 'http:':
    case 'https:':
      return httpDownload(url, maxBytes, options, signal);
    case 'ftp:':
    case 'ftps:':
      return withFtp(url, options, signal, async (client, path) => {
        const sink = new CappedSink(maxBytes);
        await client.downloadTo(sink, path);
        return sink.result();
      });
    case 'sftp:':
      return withSftp(url, options, signal, (sftp, path) => sftpRead(sftp, path, maxBytes));
    default:
      throw new FileTransferError('UnsupportedProtocol', `${url.protocol} is not supported`);
  }
}

function transferSignal(options: FileTransferOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return options.signal != null ? AbortSignal.any([options.signal, timeout]) : timeout;
}

function abortReason(signal: AbortSignal): FileTransferError {
  const reason: unknown = signal.reason;
  const timedOut = reason instanceof DOMException && reason.name === 'TimeoutError';
  return new FileTransferError(
    timedOut ? 'TransferFailed' : 'Canceled',
    timedOut ? 'The transfer timed out' : 'The transfer was canceled',
  );
}

function userinfo(url: URL): { user: string; password: string } {
  return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

/**
 * The address to connect to: an IP literal is checked directly, a name through the guarded
 * DNS lookup (every A and AAAA record checked, the connection goes to the checked address).
 */
async function guardedAddress(url: URL, options: FileTransferOptions): Promise<string> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const allowPrivateNetworks = privateAllowed(url, options);
  if (isIP(host) !== 0) {
    const blocked = allowPrivateNetworks ? isUnroutableAddress(host) : isNonPublicAddress(host);
    if (blocked) {
      throw new FileTransferError('BlockedDestination', `${host} is not an allowed address`);
    }
    return host;
  }
  const lookup = createGuardedLookup({ allowPrivateNetworks });
  return new Promise<string>((resolve, reject) => {
    lookup(host, {}, (err, address) => {
      if (err instanceof BlockedDestinationError) {
        reject(new FileTransferError('BlockedDestination', err.message, { cause: err }));
      } else if (err != null) {
        reject(new FileTransferError('TransferFailed', `${host} did not resolve`, { cause: err }));
      } else {
        resolve(address as string);
      }
    });
  });
}

function tlsTrust(options: FileTransferOptions): tls.ConnectionOptions {
  const trust: tls.ConnectionOptions = { rejectUnauthorized: options.rejectUnauthorized ?? true };
  if (options.caPem != null) trust.ca = [...tls.rootCertificates, options.caPem];
  return trust;
}

// ---------------------------------------------------------------- HTTP(S)

// PUT with the file as the body (N01.FR.18), Basic authentication from the URL userinfo
// (N01.FR.25), redirects never followed (N01.FR.30).
async function httpUpload(
  url: URL,
  body: Buffer,
  options: FileTransferOptions,
  signal: AbortSignal,
): Promise<void> {
  const address = await guardedAddress(url, options);
  const secure = url.protocol === 'https:';
  const headers: Record<string, string> = {
    host: url.host,
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
  };
  if (url.username !== '' || url.password !== '') {
    const { user, password } = userinfo(url);
    headers['authorization'] = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }
  const request: https.RequestOptions = {
    host: address,
    port: url.port !== '' ? Number(url.port) : secure ? 443 : 80,
    method: 'PUT',
    path: `${url.pathname}${url.search}`,
    headers,
    agent: false,
    signal,
  };
  if (secure) {
    Object.assign(request, tlsTrust(options));
    if (isIP(url.hostname.replace(/^\[(.*)\]$/, '$1')) === 0) request.servername = url.hostname;
  }
  let status: number;
  try {
    status = await new Promise<number>((resolve, reject) => {
      const req = (secure ? https : http).request(request, (res) => {
        res.on('error', reject);
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
        res.resume();
      });
      req.on('error', reject);
      req.end(body);
    });
  } catch (err) {
    if (signal.aborted) throw abortReason(signal);
    throw new FileTransferError('TransferFailed', 'The upload request failed', { cause: err });
  }
  if (status >= 300 && status < 400) {
    throw new FileTransferError('RedirectNotAllowed', `The server answered ${String(status)}`);
  }
  if (status === 401 || status === 403) {
    throw new FileTransferError('PermissionDenied', `The server answered ${String(status)}`);
  }
  if (status < 200 || status >= 300) {
    throw new FileTransferError('TransferFailed', `The server answered ${String(status)}`);
  }
}

async function httpDownload(
  url: URL,
  maxBytes: number,
  options: FileTransferOptions,
  signal: AbortSignal,
): Promise<Buffer> {
  // The guard covers every connection of the request, redirects included, so a host allowed
  // on a private address by name may not redirect: its redirect could name another one.
  const byName = options.allowPrivateNetworks !== true && privateAllowed(url, options);
  let response: Awaited<ReturnType<typeof safeFetch>>;
  try {
    response = await safeFetch(url.href, {
      allowPrivateNetworks: privateAllowed(url, options),
      redirect: byName ? 'error' : 'follow',
      signal,
    });
  } catch (err) {
    if (blockedDestinationOf(err) != null) {
      throw new FileTransferError('BlockedDestination', 'The address is not allowed', {
        cause: err,
      });
    }
    if (signal.aborted) throw abortReason(signal);
    throw new FileTransferError('TransferFailed', 'The download request failed', { cause: err });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new FileTransferError(
      response.status === 401 || response.status === 403 ? 'PermissionDenied' : 'TransferFailed',
      `The server answered ${String(response.status)}`,
    );
  }
  try {
    return await readCappedBody(response, maxBytes);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      throw new FileTransferError('TooLarge', `The file is larger than ${String(maxBytes)} bytes`, {
        cause: err,
      });
    }
    if (signal.aborted) throw abortReason(signal);
    throw new FileTransferError('TransferFailed', 'The download failed', { cause: err });
  }
}

// ---------------------------------------------------------------- FTP and FTPS

// basic-ftp uses passive mode only (EPSV, then PASV), and a PASV answer naming another host
// than the control connection is refused (no FTP bounce). The path of an ftp URL is relative
// to the login directory (RFC 1738, 3.2.2).
async function withFtp<T>(
  url: URL,
  options: FileTransferOptions,
  signal: AbortSignal,
  run: (client: FtpClient, path: string) => Promise<T>,
): Promise<T> {
  const address = await guardedAddress(url, options);
  const client = new FtpClient(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = (): void => {
    client.close();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const { user, password } = userinfo(url);
    const access: AccessOptions = {
      host: address,
      port: url.port !== '' ? Number(url.port) : 21,
      user: user !== '' ? user : 'anonymous',
      password: user !== '' ? password : 'anonymous@',
      secure: url.protocol === 'ftps:',
      secureOptions: {
        ...tlsTrust(options),
        ...(isIP(url.hostname.replace(/^\[(.*)\]$/, '$1')) === 0
          ? { servername: url.hostname }
          : {}),
      },
    };
    await client.access(access);
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    return await run(client, path);
  } catch (err) {
    if (err instanceof FileTransferError) throw err;
    if (signal.aborted) throw abortReason(signal);
    if (err instanceof FTPError && err.code === 530) {
      throw new FileTransferError('PermissionDenied', 'The FTP server refused the login', {
        cause: err,
      });
    }
    throw new FileTransferError('TransferFailed', 'The FTP transfer failed', { cause: err });
  } finally {
    signal.removeEventListener('abort', onAbort);
    client.close();
  }
}

/** A Writable that keeps at most `maxBytes` and fails past them. */
class CappedSink extends Writable {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (e?: Error) => void): void {
    this.size += chunk.length;
    if (this.size > this.maxBytes) {
      callback(
        new FileTransferError('TooLarge', `The file is larger than ${String(this.maxBytes)} bytes`),
      );
      return;
    }
    this.chunks.push(chunk);
    callback();
  }

  result(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// ---------------------------------------------------------------- SFTP

/** The OpenSSH SHA-256 fingerprint of a host key blob, without prefix and padding. */
export function hostKeySha256(key: Buffer): string {
  return trimTrailingPadding(createHash('sha256').update(key).digest('base64'));
}

// A backwards scan, linear in the length. The regex form /=+$/ is quadratic on
// a value with many `=` that do not end it.
function trimTrailingPadding(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 61) end--;
  return value.slice(0, end);
}

/** A configured fingerprint without the `SHA256:` prefix and padding (exported for tests). */
export function normalizeFingerprint(value: string): string {
  return trimTrailingPadding(value.trim().replace(/^SHA256:/i, ''));
}

// The host key is checked against `sftpHostKeySha256` while verification is on (no
// fingerprint: fail closed); with verification off it is accepted and logged at debug.
// The password from the URL userinfo authenticates the station. The path of an sftp URL is
// absolute.
async function withSftp<T>(
  url: URL,
  options: FileTransferOptions,
  signal: AbortSignal,
  run: (sftp: SFTPWrapper, path: string) => Promise<T>,
): Promise<T> {
  const verify = options.rejectUnauthorized ?? true;
  const expected =
    options.sftpHostKeySha256 != null && options.sftpHostKeySha256.trim() !== ''
      ? normalizeFingerprint(options.sftpHostKeySha256)
      : null;
  const address = await guardedAddress(url, options);
  if (verify && expected == null) {
    throw new FileTransferError(
      'UntrustedHostKey',
      'No SFTP host key fingerprint is configured to verify the server with',
    );
  }
  const { user, password } = userinfo(url);
  const path = decodeURIComponent(url.pathname);
  const conn = new SshClient();
  let hostKeyRejected = false;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (err: unknown, value?: T): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      conn.end();
      if (err == null) {
        resolve(value as T);
        return;
      }
      reject(
        hostKeyRejected
          ? new FileTransferError('UntrustedHostKey', 'The SFTP host key does not match', {
              cause: err,
            })
          : sftpError(err, signal),
      );
    };
    const onAbort = (): void => {
      finish(abortReason(signal));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err != null) {
          finish(err);
          return;
        }
        run(sftp, path).then(
          (value) => {
            finish(null, value);
          },
          (runErr: unknown) => {
            finish(runErr);
          },
        );
      });
    });
    conn.on('error', (err) => {
      finish(err);
    });
    const config: ConnectConfig = {
      host: address,
      port: url.port !== '' ? Number(url.port) : 22,
      username: user,
      password,
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        const fingerprint = hostKeySha256(key);
        if (!verify) {
          logger.debug(
            { host: url.hostname, fingerprint: `SHA256:${fingerprint}` },
            'SFTP host key accepted without verification',
          );
          return true;
        }
        hostKeyRejected = fingerprint !== expected;
        return !hostKeyRejected;
      },
    };
    conn.connect(config);
  });
}

// SFTP status code 3: SSH_FX_PERMISSION_DENIED.
const SFTP_PERMISSION_DENIED = 3;

function sftpError(err: unknown, signal: AbortSignal): FileTransferError {
  if (err instanceof FileTransferError) return err;
  if (signal.aborted) return abortReason(signal);
  const detail = err as { level?: string; code?: number };
  if (detail.level === 'client-authentication' || detail.code === SFTP_PERMISSION_DENIED) {
    return new FileTransferError('PermissionDenied', 'The SFTP server refused the access', {
      cause: err,
    });
  }
  return new FileTransferError('TransferFailed', 'The SFTP transfer failed', { cause: err });
}

function sftpWrite(sftp: SFTPWrapper, path: string, body: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(path, body, (err) => {
      if (err != null) reject(err);
      else resolve();
    });
  });
}

function sftpRead(sftp: SFTPWrapper, path: string, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const sink = new CappedSink(maxBytes);
    const source = sftp.createReadStream(path);
    source.on('error', reject);
    sink.on('error', (err) => {
      source.destroy();
      reject(err);
    });
    sink.on('finish', () => {
      resolve(sink.result());
    });
    source.pipe(sink);
  });
}
