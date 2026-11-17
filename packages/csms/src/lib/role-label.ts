// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { FLEET_MANAGER_ROLE_NAME } from '@evtivity/lib/user-access-scope';

/** The roles every install ships; a custom role keeps the name an admin gave it. */
export const BUILT_IN_ROLE_NAMES = [
  'admin',
  'operator',
  'viewer',
  FLEET_MANAGER_ROLE_NAME,
] as const;

/** The label of a role: the translated built-in name, else the stored name. */
export function roleLabel(name: string, t: TFunction): string {
  return (BUILT_IN_ROLE_NAMES as readonly string[]).includes(name)
    ? t(`users.roleNames.${name}`, { defaultValue: name })
    : name;
}
