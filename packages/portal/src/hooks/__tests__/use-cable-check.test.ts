// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import i18next from 'i18next';
import { ApiError } from '@/lib/api';

const i18n = i18next.createInstance();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: i18n.t }),
}));

const { useCableCheck } = await import('../use-cable-check');

beforeAll(async () => {
  await i18n.init({
    lng: 'de',
    resources: {
      de: {
        translation: {
          errors: { STATUS_CHECK_TIMEOUT: 'Zeitüberschreitung bei der Statusabfrage.' },
          charger: { statusCheckFailed: 'Status konnte nicht geprüft werden.' },
        },
      },
    },
  });
});

async function run(check: () => Promise<{ connectorStatus: string }>) {
  const { result } = renderHook(() => useCableCheck());
  const setError = vi.fn();
  const onProceed = vi.fn();
  await act(async () => {
    await result.current.runWithCableCheck(check, onProceed, setError);
  });
  return { result, setError, onProceed };
}

describe('useCableCheck', () => {
  it('shows the translated message for a failed check error code', async () => {
    const { setError, onProceed } = await run(() =>
      Promise.reject(
        new ApiError(504, {
          error: 'Status check timed out. Replug the connector and try again.',
          code: 'STATUS_CHECK_TIMEOUT',
        }),
      ),
    );
    expect(setError).toHaveBeenLastCalledWith('Zeitüberschreitung bei der Statusabfrage.');
    expect(onProceed).not.toHaveBeenCalled();
  });

  it('shows the translated fallback when the failure has no error code', async () => {
    const { setError } = await run(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(setError).toHaveBeenLastCalledWith('Status konnte nicht geprüft werden.');
  });

  it('opens the EV warning when no cable is detected', async () => {
    const { result, onProceed } = await run(() =>
      Promise.resolve({ connectorStatus: 'available' }),
    );
    expect(result.current.showEvWarning).toBe(true);
    expect(onProceed).not.toHaveBeenCalled();
  });

  it('proceeds when a cable is detected', async () => {
    const { onProceed, setError } = await run(() =>
      Promise.resolve({ connectorStatus: 'preparing' }),
    );
    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenLastCalledWith('');
  });
});
