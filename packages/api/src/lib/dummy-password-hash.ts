// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import argon2 from 'argon2';

// Lazily computed argon2 hash of random data. A sign-in that finds no account
// (or one without a password) verifies the password against it, so the
// answer takes as long as a wrong password on a real account and the response
// time does not tell whether the email exists.
let dummyPasswordHashPromise: Promise<string> | null = null;

function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHashPromise ??= argon2.hash(crypto.randomBytes(32).toString('hex'));
  return dummyPasswordHashPromise;
}

/** Spends the time of one password check and always answers false. */
export async function verifyAgainstDummyHash(password: string): Promise<false> {
  await argon2.verify(await getDummyPasswordHash(), password).catch(() => false);
  return false;
}
