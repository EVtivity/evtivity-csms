// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { getApiErrorCode } from '@/lib/api';

/** The translated text of an AI error code; server text is never shown. */
export function aiErrorText(code: string, t: TFunction): string {
  const key = `errors.${code}` as 'errors.unknown';
  const translated: string = t(key);
  return translated !== key ? translated : t('ai.errors.generic');
}

/** The translated text of a failed AI request, by its error code only. */
export function aiRequestErrorText(err: unknown, t: TFunction): string {
  const code = getApiErrorCode(err);
  return code != null ? aiErrorText(code, t) : t('ai.errors.generic');
}
