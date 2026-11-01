// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * Form values loaded from the settings. A settings refetch (another card's
 * save, a toggle, window focus) replaces them only while the form is clean,
 * so edits in progress survive it; after this form's own save they equal
 * the new values. `onReplace` runs when a reload replaces the values, so the
 * form can reset its submitted state.
 *
 * The third item, `takeNextLoad(saved)`, is for the form's own save: call it
 * with the values the save sent, and the next reload replaces the form when
 * it still holds those values, also when the server stored them in another
 * form (a trimmed URL, a normalized number). Edits made after the save stay.
 *
 * The fourth item, `base`, is the loaded values the form holds since it last
 * took a load: the first load, a reload that replaced the values, or a reload
 * equal to the values. A secret field whose value still equals `base` was not
 * edited in this session of the form, so the save leaves it out
 * (`withoutUntouchedSecrets`): a dirty form keeps the secret it loaded
 * earlier, and sending it would put back a secret another user rotated since.
 */
export function useLoadedValues<T extends object>(
  loaded: T,
  onReplace?: () => void,
): [T, Dispatch<SetStateAction<T>>, (saved: T) => void, T] {
  const [values, setValues] = useState<T>(loaded);
  const [base, setBase] = useState<T>(loaded);
  const loadedKey = JSON.stringify(loaded);
  const [previousKey, setPreviousKey] = useState(loadedKey);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  if (previousKey !== loadedKey) {
    setPreviousKey(loadedKey);
    setSavedKey(null);
    const valuesKey = JSON.stringify(values);
    if (valuesKey === previousKey || valuesKey === savedKey) {
      setValues(loaded);
      setBase(loaded);
      onReplace?.();
    } else if (valuesKey === loadedKey) {
      setBase(loaded);
    }
  }
  const takeNextLoad = useCallback((saved: T) => {
    setSavedKey(JSON.stringify(saved));
  }, []);
  return [values, setValues, takeNextLoad, base];
}

/** The field holds another value than the form loaded: the user edited it. */
export function isEditedField<T extends object>(values: T, base: T, key: keyof T): boolean {
  return values[key] !== base[key];
}

/**
 * The values to save, without each secret field the user did not edit in this
 * session of the form (its value still equals `base`). The API keeps the
 * stored value of a secret left out of the save.
 */
export function withoutUntouchedSecrets<T extends object, K extends keyof T>(
  values: T,
  base: T,
  secretKeys: readonly K[],
): WithOptional<T, K> {
  const untouched = new Set<PropertyKey>(
    secretKeys.filter((key) => !isEditedField(values, base, key)),
  );
  const kept = Object.entries(values).filter(([key]) => !untouched.has(key));
  return Object.fromEntries(kept) as WithOptional<T, K>;
}

/** `T` with the keys `K` optional. */
type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * The values to compare edits with for the Unsaved changes note: the last
 * saved values until the next load replaces them.
 */
export function useSavedBaseline<T>(loaded: T): [T, (saved: T) => void] {
  const [saved, setSaved] = useState<{ loadedKey: string; value: T } | null>(null);
  const loadedKey = JSON.stringify(loaded);
  const baseline = saved != null && saved.loadedKey === loadedKey ? saved.value : loaded;
  return [
    baseline,
    (value: T) => {
      setSaved({ loadedKey, value });
    },
  ];
}
