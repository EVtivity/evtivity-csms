// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A secret of the payment provider settings GETs. The GET returns the value
 * only to users who also hold `settings.system:read`; everyone else gets null
 * plus whether a value is stored.
 */
export interface StoredSecret {
  /** The decrypted value, or null when unset or not returned to this user. */
  value: string | null;
  /** A value is stored. */
  configured: boolean;
}

/** A value is stored but the GET did not return it to this user. */
export function isHiddenSecret(secret: StoredSecret): boolean {
  return secret.configured && secret.value == null;
}

/**
 * The body value to send for a secret field on save, or undefined to leave the
 * stored value as it is. `taken` is the value the form loaded for the field
 * (`base` of `useLoadedValues`): a field the user did not edit in this session
 * of the form is never sent, so a dirty form cannot put back a secret another
 * user rotated after it loaded.
 *
 * - Value shown (returned by the GET): send it when the user changed it; an
 *   emptied field sends '' and clears the secret.
 * - Value hidden: send what the user typed. An empty field keeps the stored
 *   value; only an explicit remove sends '' and clears it.
 */
export function secretChange(
  input: string,
  secret: StoredSecret,
  removing: boolean,
  taken: string,
): string | undefined {
  const value = input.trim();
  if (isHiddenSecret(secret)) {
    if (value !== '') return value;
    return removing ? '' : undefined;
  }
  return value !== taken.trim() ? value : undefined;
}
