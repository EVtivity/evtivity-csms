// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { StationImages } from '../StationImages';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  getMock.mockReset();
  postMock.mockReset();
});

async function renderImages(): Promise<HTMLInputElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <StationImages stationId="sta_1" />
    </QueryClientProvider>,
  );
  // The file input appears once the image list has loaded.
  return waitFor(() => {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no file input');
    return input;
  });
}

describe('StationImages upload', () => {
  it('offers raster images only', async () => {
    getMock.mockResolvedValue([]);
    const input = await renderImages();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(input.accept).toBe('image/png,image/jpeg,image/webp');
  });

  it('posts the file with the presigned form fields, then confirms the quarantine key', async () => {
    getMock.mockResolvedValue([]);
    postMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/upload-url')
          ? {
              uploadUrl: 'https://s3.example.com/bucket',
              fields: { key: 'ai-uploads/quarantine/stations/sta_1/u/photo.png', Policy: 'p' },
              s3Key: 'ai-uploads/quarantine/stations/sta_1/u/photo.png',
              s3Bucket: 'bucket',
            }
          : { id: 1 },
      ),
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const input = await renderImages();
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/stations/sta_1/images', expect.anything());
    });
    const [target, init] = fetchMock.mock.calls[0] as [string, { method: string; body: FormData }];
    expect(target).toBe('https://s3.example.com/bucket');
    expect(init.method).toBe('POST');
    expect([...init.body.keys()]).toEqual(['key', 'Policy', 'file']);
    expect(postMock).toHaveBeenCalledWith('/v1/stations/sta_1/images', {
      fileName: 'photo.png',
      fileSize: 3,
      contentType: 'image/png',
      s3Key: 'ai-uploads/quarantine/stations/sta_1/u/photo.png',
      s3Bucket: 'bucket',
    });
  });
});
