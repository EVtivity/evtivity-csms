// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Validate password complexity beyond minimum length.
 * Zod .regex() refines do not translate to JSON Schema for Fastify AJV validation,
 * so length is enforced in the Zod schema and complexity is checked here.
 *
 * Returns an error message string if validation fails, or null if the password is valid.
 */
export function validatePasswordComplexity(password: string): string | null {
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain a number';
  return null;
}
