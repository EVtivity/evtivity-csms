// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  chain['catch'] = (onRejected?: (r: unknown) => unknown) => Promise.resolve([]).catch(onRejected);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  users: {
    id: 'id',
    email: 'email',
    firstName: 'firstName',
    lastName: 'lastName',
    roleId: 'roleId',
    isActive: 'isActive',
    lastLoginAt: 'lastLoginAt',
    createdAt: 'createdAt',
    passwordHash: 'passwordHash',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed_password'),
  },
}));

import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  changePassword,
} from '../services/user.service.js';
import argon2 from 'argon2';

beforeEach(() => {
  dbResults = [];
  dbCallIndex = 0;
  vi.clearAllMocks();
});

describe('listUsers', () => {
  it('returns user list', async () => {
    const userRows = [
      { id: 'u1', email: 'admin@test.com', firstName: 'Admin', lastName: 'User', isActive: true },
      { id: 'u2', email: 'op@test.com', firstName: 'Op', lastName: 'User', isActive: true },
    ];
    setupDbResults(userRows);

    const result = await listUsers();

    expect(result).toEqual(userRows);
  });
});

describe('getUser', () => {
  it('returns user when found', async () => {
    const user = { id: 'u1', email: 'admin@test.com', firstName: 'Admin' };
    setupDbResults([user]);

    const result = await getUser('u1');

    expect(result).toEqual(user);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

    const result = await getUser('nonexistent');

    expect(result).toBeNull();
  });
});

describe('createUser', () => {
  it('hashes password and inserts user', async () => {
    const user = {
      id: 'u1',
      email: 'new@test.com',
      firstName: 'New',
      lastName: 'User',
      roleId: 'r1',
    };
    setupDbResults([user]);

    const result = await createUser({
      email: 'new@test.com',
      password: 'TestPassword1',
      firstName: 'New',
      lastName: 'User',
      roleId: 'r1',
    });

    expect(argon2.hash).toHaveBeenCalledWith('TestPassword1');
    expect(result).toEqual(user);
  });
});

describe('updateUser', () => {
  it('returns updated user when found', async () => {
    const user = { id: 'u1', email: 'updated@test.com', firstName: 'Updated' };
    setupDbResults([user]);

    const result = await updateUser('u1', { email: 'updated@test.com', firstName: 'Updated' });

    expect(result).toEqual(user);
  });

  it('returns null when not found', async () => {
    setupDbResults([]);

    const result = await updateUser('nonexistent', { email: 'x@test.com' });

    expect(result).toBeNull();
  });
});

describe('deleteUser', () => {
  it('sets isActive to false and returns user', async () => {
    const user = { id: 'u1', email: 'deleted@test.com' };
    setupDbResults([user]);

    const result = await deleteUser('u1');

    expect(result).toEqual(user);
  });
});

describe('changePassword', () => {
  it('hashes new password and updates user', async () => {
    const user = { id: 'u1' };
    setupDbResults([user]);

    const result = await changePassword('u1', 'NewPassword1');

    expect(argon2.hash).toHaveBeenCalledWith('NewPassword1');
    expect(result).toEqual(user);
  });
});
