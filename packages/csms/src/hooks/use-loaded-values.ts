// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * Form values loaded from the settings. A settings refetch (another card's
 * save, a toggle, window focus) replaces them only while the form is clean,
 * so edits in progress survive it; after this form's own save they equal
 * the new values. `onReplace` runs when a reload replaces the values, so the
 * form can reset its submitted state.
 */
export function useLoadedValues<T extends object>(
  loaded: T,
  onReplace?: () => void,
): [T, Dispatch<SetStateAction<T>>] {
  const [values, setValues] = useState<T>(loaded);
  const loadedKey = JSON.stringify(loaded);
  const [previousKey, setPreviousKey] = useState(loadedKey);
  if (previousKey !== loadedKey) {
    setPreviousKey(loadedKey);
    if (JSON.stringify(values) === previousKey) {
      setValues(loaded);
      onReplace?.();
    }
  }
  return [values, setValues];
}
