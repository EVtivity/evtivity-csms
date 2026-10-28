// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, putMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  function getApiErrorCode(err: unknown): string | null {
    if (!(err instanceof ApiError)) return null;
    const body = err.body as { code?: unknown } | null;
    return typeof body?.code === 'string' ? body.code : null;
  }
  return {
    api: { get: getMock, put: putMock, post: postMock, delete: deleteMock },
    ApiError,
    getApiErrorCode,
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { ApiError } from '@/lib/api';
import { AvatarEditor, AvatarField } from '../AvatarEditor';
import { AVATAR_QUERY_KEY, type DriverAvatar as Avatar } from '@/lib/avatar';

const GENERATED = {
  kind: 'generated',
  style: 'avataaars',
  seed: 'abc',
  options: { topVariant: 'bob', skinColor: '614335', accessoriesProbability: 0 },
  updatedAt: null,
} as const;

function mockFeatures(uploadEnabled: boolean): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/v1/portal/features')
      return Promise.resolve({ avatarUploadEnabled: uploadEnabled });
    if (path === '/v1/portal/driver/avatar') return Promise.resolve({ avatar: GENERATED });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

let queryClient: QueryClient;

function renderEditor(props: Partial<React.ComponentProps<typeof AvatarEditor>> = {}): {
  onDone: ReturnType<typeof vi.fn>;
  onChoose: ReturnType<typeof vi.fn>;
} {
  const onDone = vi.fn();
  const onChoose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <AvatarEditor
        current={GENERATED as unknown as Avatar}
        firstName="Ana"
        lastName="Lee"
        mode="live"
        onDone={onDone}
        onChoose={onChoose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onDone, onChoose };
}

async function previewSrc(): Promise<string> {
  const img = await screen.findByAltText('account.avatarAlt');
  return img.getAttribute('src') ?? '';
}

function clickInDialog(label: string): void {
  const dialog = screen.getByRole('dialog');
  fireEvent.click(
    Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent === label,
    ) as HTMLButtonElement,
  );
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  putMock.mockResolvedValue({ avatar: GENERATED });
  postMock.mockReset();
  deleteMock.mockResolvedValue({ avatar: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AvatarEditor, live', () => {
  it('starts from the saved avatar, saves the chosen options and stores the reply', async () => {
    mockFeatures(false);
    const { onDone } = renderEditor();
    const select = await screen.findByLabelText('account.avatarOptions.topVariant');
    expect((select as HTMLSelectElement).value).toBe('bob');
    fireEvent.change(select, { target: { value: 'frizzle' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
    const [path, body] = putMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/v1/portal/driver/avatar');
    expect(body).toEqual({
      style: 'avataaars',
      seed: 'abc',
      options: {
        topVariant: 'frizzle',
        topProbability: 100,
        skinColor: '614335',
        accessoriesProbability: 0,
      },
    });
    expect(queryClient.getQueryData(AVATAR_QUERY_KEY)).toEqual(GENERATED);
  });

  it('shows a probability of 0 as None and stores None and a picked variant', async () => {
    mockFeatures(false);
    renderEditor();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const glasses = await screen.findByLabelText<HTMLSelectElement>(
      'account.avatarOptions.accessoriesVariant',
    );
    expect(glasses.value).toBe('none');
    expect(glasses.options[0]?.textContent).toBe('account.avatarNone.accessoriesVariant');
    expect(
      screen.queryByRole('group', { name: 'account.avatarOptions.accessoriesColor' }),
    ).toBeNull();
    fireEvent.change(glasses, { target: { value: 'round' } });
    expect(
      screen.getByRole('group', { name: 'account.avatarOptions.accessoriesColor' }),
    ).toBeTruthy();
    const top = screen.getByLabelText('account.avatarOptions.topVariant');
    fireEvent.change(top, { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalled();
    });
    const [, body] = putMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body['options']).toEqual({
      topVariant: 'bob',
      topProbability: 0,
      skinColor: '614335',
      accessoriesVariant: 'round',
      accessoriesProbability: 100,
    });
  });

  it('Random changes the preview', async () => {
    mockFeatures(false);
    renderEditor();
    const before = await previewSrc();
    expect(before.startsWith('data:image/svg+xml')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /account.avatarRandom/ }));
    await waitFor(async () => {
      expect(await previewSrc()).not.toBe(before);
    });
  });

  it('hides the upload without file storage', async () => {
    mockFeatures(false);
    renderEditor({ current: null });
    await screen.findByLabelText('account.avatarOptions.topVariant');
    expect(screen.queryByRole('button', { name: 'account.avatarUpload' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'account.avatarRemove' })).toBeNull();
  });

  it('refuses a 1 MiB file and an SVG before any request', async () => {
    mockFeatures(true);
    renderEditor({ current: null });
    fireEvent.click(await screen.findByRole('button', { name: 'account.avatarUpload' }));
    const input = screen.getByTestId('avatar-file');
    const big = new File([new Uint8Array(1024 * 1024)], 'big.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText('account.avatarTooLarge')).toBeTruthy();
    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' });
    fireEvent.change(input, { target: { files: [svg] } });
    expect(await screen.findByText('account.avatarWrongType')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('opens the storage dialog, not an inline error, when the upload answers STORAGE_NOT_CONFIGURED', async () => {
    mockFeatures(true);
    postMock.mockRejectedValue(
      new ApiError(400, { error: 'S3 not configured', code: 'STORAGE_NOT_CONFIGURED' }),
    );
    const { onDone } = renderEditor({ current: null });
    fireEvent.click(await screen.findByRole('button', { name: 'account.avatarUpload' }));
    const photo = new File([new Uint8Array(10)], 'a.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [photo] } });
    const dialog = await screen.findByRole('dialog', { name: 'storageUnavailable.title' });
    expect(dialog.textContent).toContain('storageUnavailable.description');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    clickInDialog('common.ok');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('removes the avatar after the confirmation', async () => {
    mockFeatures(false);
    const { onDone } = renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: 'account.avatarRemove' }));
    await screen.findByRole('dialog');
    clickInDialog('account.avatarRemove');
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/portal/driver/avatar');
    });
    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
    expect(queryClient.getQueryData(AVATAR_QUERY_KEY)).toBeNull();
  });

  it('shows the error of a refused save and stays open', async () => {
    mockFeatures(false);
    putMock.mockRejectedValue(new Error('boom'));
    const { onDone } = renderEditor();
    await screen.findByLabelText('account.avatarOptions.topVariant');
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('AvatarEditor, deferred', () => {
  it('hands the chosen avatar to the caller without a request and offers no upload', async () => {
    mockFeatures(true);
    const { onChoose, onDone } = renderEditor({ mode: 'deferred', current: null });
    const top = await screen.findByLabelText('account.avatarOptions.topVariant');
    fireEvent.change(top, { target: { value: 'frizzle' } });
    expect(screen.queryByRole('button', { name: 'account.avatarUpload' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    const chosen = onChoose.mock.calls[0]?.[0] as { style: string; options: object };
    expect(chosen.style).toBe('avataaars');
    expect(chosen.options).toMatchObject({ topVariant: 'frizzle' });
    expect(chosen).not.toHaveProperty('kind');
    expect(onDone).toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalledWith('/v1/portal/features');
  });

  it('clears the choice with Remove, without a confirmation or a request', async () => {
    mockFeatures(false);
    const { onChoose } = renderEditor({ mode: 'deferred' });
    fireEvent.click(await screen.findByRole('button', { name: 'account.avatarRemove' }));
    expect(onChoose).toHaveBeenCalledWith(null);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe('AvatarField', () => {
  it('shows the avatar and opens the editor in a dialog with Edit', async () => {
    mockFeatures(false);
    render(
      <QueryClientProvider client={queryClient}>
        <AvatarField
          avatar={GENERATED as unknown as Avatar}
          firstName="Ana"
          lastName="Lee"
          mode="live"
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText('account.avatar')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'account.editAvatar' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await screen.findByLabelText('account.avatarOptions.topVariant');
    clickInDialog('common.cancel');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
