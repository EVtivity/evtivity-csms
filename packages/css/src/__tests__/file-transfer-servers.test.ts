// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import ssh2 from 'ssh2';
import { ed25519HostKey } from './file-transfer-servers.js';

describe('ed25519HostKey', () => {
  // ssh2's own ed25519 key generation stripped leading zero bytes, so about one key in 256 did
  // not parse and the SFTP tests failed at random. 2000 keys hold several with a leading zero.
  it('makes a host key ssh2 parses and signs with, every time', () => {
    const data = Buffer.from('host key check');
    for (let i = 0; i < 2000; i++) {
      const { privateKey, publicSSH } = ed25519HostKey();
      const parsed = ssh2.utils.parseKey(privateKey);
      if (parsed instanceof Error) throw parsed;
      expect(parsed.type).toBe('ssh-ed25519');
      expect(parsed.getPublicSSH().equals(publicSSH)).toBe(true);
      const signature = parsed.sign(data);
      if (signature instanceof Error) throw signature;
      expect(parsed.verify(data, signature)).toBe(true);
    }
  });
});
