// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Passwords of bus depot systems (VDV 463 HTTP Basic authentication). The
// password is generated here, shown once, and only its argon2id hash is
// stored: EVtivity verifies it and never sends it (design principle P12).

import crypto from 'node:crypto';
import argon2 from 'argon2';
import { STATION_PASSWORD_HASH_OPTIONS } from '@evtivity/lib/station-password';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const DEPOT_SYSTEM_PASSWORD_LENGTH = 32;

/** 32 characters of an unambiguous alphabet (about 186 bits). */
export function generateDepotSystemPassword(): string {
  const bytes = crypto.randomBytes(DEPOT_SYSTEM_PASSWORD_LENGTH * 2);
  let out = '';
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  for (const b of bytes) {
    if (out.length >= DEPOT_SYSTEM_PASSWORD_LENGTH) break;
    // Rejection sampling keeps every character equally likely.
    if (b < limit) out += ALPHABET.charAt(b % ALPHABET.length);
  }
  return out.length === DEPOT_SYSTEM_PASSWORD_LENGTH ? out : generateDepotSystemPassword();
}

/**
 * argon2id with the station password parameters (19 MiB, t=2, p=1, the OWASP
 * minimum): the password is 186 random bits, so a heavier hash adds no
 * guessing cost, while every unauthenticated upgrade pays one verify
 * (security review M2 of the bus depot interface).
 */
const HASH_OPTIONS = { ...STATION_PASSWORD_HASH_OPTIONS, type: argon2.argon2id } as const;

export function hashDepotSystemPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS);
}

let dummyHash: Promise<string> | null = null;

/** A hash with the same parameters, so an unknown system costs the same check. */
function dummy(): Promise<string> {
  dummyHash ??= argon2.hash(generateDepotSystemPassword(), HASH_OPTIONS);
  return dummyHash;
}

/**
 * Verifies a password against a stored hash, or against a dummy hash when the
 * depot system is unknown, so the answer time tells nothing about the name.
 */
export async function verifyDepotSystemPassword(
  hash: string | null,
  password: string,
): Promise<boolean> {
  try {
    if (hash == null) {
      await argon2.verify(await dummy(), password);
      return false;
    }
    return await argon2.verify(hash, password);
  } catch {
    // fail-open: a malformed stored hash verifies nothing, the sign-in is refused
    return false;
  }
}
