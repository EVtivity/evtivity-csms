// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const { putMock, postMock, deleteMock, uploadMock } = vi.hoisted(() => ({
  putMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
  uploadMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
  }),
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
  return { api: { put: putMock, post: postMock, delete: deleteMock }, ApiError };
});

vi.mock('@evtivity/lib/account-avatar', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  postAvatarUpload: uploadMock,
}));

import { ApiError } from '@/lib/api';
import { AvatarField } from '../AvatarField';
import { applyAvatarChoice, OWN_AVATAR_PATH } from '@/lib/avatar';
import type { AvatarChoice } from '@/lib/avatar';

const SAVED = {
  kind: 'generated' as const,
  style: 'avataaars' as const,
  seed: 'Ana42',
  options: { topVariant: 'bob', skinColor: '614335' },
};

function renderField(
  onSave: ((choice: AvatarChoice) => Promise<void>) | undefined,
  avatar: typeof SAVED | null = SAVED,
): void {
  render(
    <AvatarField
      avatar={avatar}
      firstName="Ana"
      lastName="Lee"
      {...(onSave != null ? { onSave } : {})}
    />,
  );
}

async function openEditor(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /avatar\.edit/ }));
  await screen.findByRole('button', { name: /avatar\.random/ });
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AvatarField and AvatarEditor', () => {
  it('is read-only without onSave', async () => {
    renderField(undefined);
    expect(await screen.findByAltText('avatar.alt')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /avatar\.edit/ })).toBeNull();
  });

  it('starts from the saved avatar and hands back the edited options with None', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderField(onSave);
    await openEditor();
    const top = screen.getByRole('combobox', { name: /avatar\.options\.topVariant/ });
    expect((top as HTMLSelectElement).value).toBe('bob');
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.change(top, { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        kind: 'generated',
        avatar: {
          style: 'avataaars',
          seed: 'Ana42',
          options: { topVariant: 'bob', topProbability: 0, skinColor: '614335' },
        },
      });
    });
    // Success closes the editor.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /avatar\.random/ })).toBeNull();
    });
  });

  it('keeps the editor open with the translated error when the save fails', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(new ApiError(400, { error: 'x', code: 'VALIDATION_ERROR' }));
    renderField(onSave);
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /avatar\.random/ })).toBeTruthy();
  });

  it('checks a picked file before handing it back', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderField(onSave);
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /avatar\.upload/ }));
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' });
    fireEvent.change(fileInput(), { target: { files: [svg] } });
    expect((await screen.findByRole('alert')).textContent).toBe('avatar.wrongType');
    const big = new File([new Uint8Array(1024 * 1024)], 'a.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput(), { target: { files: [big] } });
    expect((await screen.findByRole('alert')).textContent).toBe('avatar.tooLarge');
    expect(onSave).not.toHaveBeenCalled();
    const photo = new File([new Uint8Array(10)], 'a.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput(), { target: { files: [photo] } });
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({ kind: 'image', file: photo });
    });
  });

  it('removes behind a confirmation, and offers Remove only with an avatar', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderField(onSave);
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /^avatar\.remove$/ }));
    const confirm = await screen.findAllByRole('button', { name: /avatar\.remove/ });
    fireEvent.click(confirm[confirm.length - 1] as HTMLElement);
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({ kind: 'remove' });
    });
    cleanup();
    renderField(onSave, null);
    await openEditor();
    expect(screen.queryByRole('button', { name: /^avatar\.remove$/ })).toBeNull();
  });
});

describe('applyAvatarChoice', () => {
  it('sends a generated avatar, an upload and a removal to the given routes', async () => {
    putMock.mockResolvedValueOnce({ avatar: SAVED });
    await expect(
      applyAvatarChoice(OWN_AVATAR_PATH, {
        kind: 'generated',
        avatar: { style: 'avataaars', seed: 'Ana42', options: {} },
      }),
    ).resolves.toEqual(SAVED);
    expect(putMock).toHaveBeenCalledWith('/v1/users/me/avatar', {
      style: 'avataaars',
      seed: 'Ana42',
      options: {},
    });

    const ticket = { uploadUrl: 'u', fields: {}, s3Key: 'k', s3Bucket: 'b' };
    postMock.mockResolvedValueOnce(ticket).mockResolvedValueOnce({ avatar: null });
    const file = new File([new Uint8Array(5)], 'p.png', { type: 'image/png' });
    await applyAvatarChoice(OWN_AVATAR_PATH, { kind: 'image', file });
    expect(postMock).toHaveBeenNthCalledWith(1, '/v1/users/me/avatar/upload-url', {
      fileName: 'p.png',
      contentType: 'image/png',
      fileSize: 5,
    });
    expect(uploadMock).toHaveBeenCalledWith(ticket, file);
    expect(postMock).toHaveBeenNthCalledWith(2, '/v1/users/me/avatar/image', {
      s3Key: 'k',
      s3Bucket: 'b',
    });

    deleteMock.mockResolvedValueOnce({ avatar: null });
    await expect(applyAvatarChoice(OWN_AVATAR_PATH, { kind: 'remove' })).resolves.toBeNull();
    expect(deleteMock).toHaveBeenCalledWith('/v1/users/me/avatar');
  });
});
