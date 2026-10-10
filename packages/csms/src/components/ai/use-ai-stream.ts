// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect, useRef, useState } from 'react';
import { readAiStream } from '@evtivity/lib/ai-stream';
import type { AiStreamEvent } from '@evtivity/lib/ai-stream';
import { postStream } from '@/lib/api';

export type AiStreamOutcome =
  | { kind: 'completed' }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: unknown };

export interface UseAiStreamResult {
  /** Posts `body` to a streaming endpoint and calls `onEvent` for each event. */
  run: (
    path: string,
    body: unknown,
    onEvent: (event: AiStreamEvent) => void,
  ) => Promise<AiStreamOutcome>;
  /** Aborts the running stream. The server saves the partial answer. */
  stop: () => void;
  streaming: boolean;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * One AI turn at a time over `fetch` + `readAiStream`. Unmounting aborts the
 * running stream.
 */
export function useAiStream(): UseAiStreamResult {
  const controllerRef = useRef<AbortController | null>(null);
  const [streaming, setStreaming] = useState(false);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const run = useCallback(
    async (
      path: string,
      body: unknown,
      onEvent: (event: AiStreamEvent) => void,
    ): Promise<AiStreamOutcome> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setStreaming(true);
      try {
        const stream = await postStream(path, body, controller.signal);
        for await (const event of readAiStream(stream)) {
          onEvent(event);
        }
        return controller.signal.aborted ? { kind: 'stopped' } : { kind: 'completed' };
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return { kind: 'stopped' };
        return { kind: 'failed', error: err };
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setStreaming(false);
        }
      }
    },
    [],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { run, stop, streaming };
}
