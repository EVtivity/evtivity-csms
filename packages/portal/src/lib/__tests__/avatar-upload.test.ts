// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The driver avatar photo upload: an upload URL for the file, the browser
// upload to storage, then the confirm that returns the stored avatar.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPost, mockPostAvatarUpload } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockPostAvatarUpload: vi.fn(() => Promise.resolve()),
}));

vi.mock('../api', () => ({ api: { post: mockPost, get: vi.fn() } }));
vi.mock('@evtivity/lib/account-avatar', () => ({ postAvatarUpload: mockPostAvatarUpload }));

import { initialsOf, uploadAvatarImage } from '../avatar';

beforeEach(() => {
  mockPost.mockReset();
  mockPostAvatarUpload.mockClear();
});

describe('uploadAvatarImage', () => {
  it('asks for an upload URL for the file, uploads it, then confirms its key', async () => {
    const ticket = {
      s3Key: 'quarantine/avatars/drv_1/u/avatar',
      s3Bucket: 'b',
      uploadMethod: 'POST',
    };
    const avatar = { kind: 'image', url: 'https://s3/x', expiresAt: null, updatedAt: null };
    mockPost.mockResolvedValueOnce(ticket).mockResolvedValueOnce({ avatar });
    const file = new File([new Uint8Array(10)], 'me.png', { type: 'image/png' });
    await expect(uploadAvatarImage(file)).resolves.toEqual(avatar);
    expect(mockPost).toHaveBeenNthCalledWith(1, '/v1/portal/driver/avatar/upload-url', {
      fileName: 'me.png',
      contentType: 'image/png',
      fileSize: 10,
    });
    expect(mockPostAvatarUpload).toHaveBeenCalledWith(ticket, file);
    expect(mockPost).toHaveBeenNthCalledWith(2, '/v1/portal/driver/avatar/image', {
      s3Key: ticket.s3Key,
      s3Bucket: 'b',
    });
  });

  it('confirms nothing when the storage upload fails', async () => {
    mockPost.mockResolvedValueOnce({ s3Key: 'k', s3Bucket: 'b' });
    mockPostAvatarUpload.mockRejectedValueOnce(new Error('403 from storage'));
    const file = new File(['x'], 'me.jpg', { type: 'image/jpeg' });
    await expect(uploadAvatarImage(file)).rejects.toThrow('403 from storage');
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe('initialsOf', () => {
  it('takes up to two initials, upper case, skipping blank parts', () => {
    expect(initialsOf('ada', 'lovelace')).toBe('AL');
    expect(initialsOf('  ', 'Hopper')).toBe('H');
    expect(initialsOf(null, undefined)).toBe('');
  });
});
