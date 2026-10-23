// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn() }));
const editor = vi.hoisted(() => ({ onChange: null as null | ((v: string[]) => void) }));

vi.mock('@/lib/auth', () => ({
  useHasAllSiteAccess: () => true,
  useHasPermission: () => true,
  useAuth: (select?: (s: Record<string, unknown>) => unknown) => {
    const state = { user: null };
    return select != null ? select(state) : state;
  },
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api, getApiErrorCode: () => null }));
vi.mock('@/hooks/use-password-policy', () => ({
  usePasswordPolicy: () => ({
    minLength: 8,
    requireUppercase: false,
    requireLowercase: false,
    requireNumber: false,
    requireSymbol: false,
  }),
  useWeakPasswordReply: () => () => null,
}));
vi.mock('@/components/PermissionEditor', () => ({
  PermissionEditor: ({ onChange }: { onChange: (v: string[]) => void }) => {
    editor.onChange = onChange;
    return null;
  },
}));
vi.mock('@/components/FactorProofField', () => ({
  FactorProofField: ({ onChange }: { onChange: (p: unknown) => void }) => (
    <button
      type="button"
      onClick={() => {
        onChange({ kind: 'password', password: 'secret' });
      }}
    >
      give-proof
    </button>
  ),
  proofRejection: () => ({ code: null }),
}));

import { UserPermissionsTab } from '../UserPermissionsTab';
import { UserSecurityTab } from '../UserSecurityTab';
import { UserAccessCards } from '../UserAccessCards';
import { UserDetailsTab, type UserDetailUser } from '../UserDetailsTab';
import { permissionCatalog } from '@evtivity/lib/permissions';

function wrap(node: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  api.get.mockImplementation((url: string) =>
    Promise.resolve(
      url === '/v1/users/me/mfa'
        ? { factorProofKinds: ['password'], mfaMethod: null }
        : ['stations:read', 'sites:read'],
    ),
  );
  api.put.mockResolvedValue([]);
  api.post.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UserPermissionsTab fresh proof', () => {
  async function startEdit(): Promise<void> {
    wrap(<UserPermissionsTab userId="usr_1" canEdit />);
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/v1/users/usr_1/permissions');
    });
    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
  }

  it('asks for the proof before a grant and sends it', async () => {
    await startEdit();
    editor.onChange?.(['stations:read', 'sites:read', 'payments:write']);
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText('give-proof'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/v1/users/usr_1/permissions', {
        permissions: ['stations:read', 'sites:read', 'payments:write'],
        proof: { kind: 'password', password: 'secret' },
      });
    });
  });

  it('removes a permission without a proof', async () => {
    await startEdit();
    editor.onChange?.(['stations:read']);
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/v1/users/usr_1/permissions', {
        permissions: ['stations:read'],
      });
    });
    expect(screen.queryByText('give-proof')).toBeNull();
  });
});

describe('UserSecurityTab fresh proof', () => {
  it('sends the proof with the admin password reset', async () => {
    wrap(<UserSecurityTab userId="usr_1" />);
    fireEvent.change(screen.getByLabelText('users.newPassword'), {
      target: { value: 'LongEnoughPassword1!' },
    });
    fireEvent.click(await screen.findByText('give-proof'));
    fireEvent.click(screen.getByRole('button', { name: 'users.resetPassword' }));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/v1/users/usr_1/reset-password', {
        password: 'LongEnoughPassword1!',
        proof: { kind: 'password', password: 'secret' },
      });
    });
  });
});

describe('UserAccessCards fresh proof for the MFA reset', () => {
  it('asks for the proof before the MFA reset and sends it', async () => {
    api.get.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/v1/users/me/mfa' ? { factorProofKinds: ['password'], mfaMethod: null } : [],
      ),
    );
    wrap(<UserAccessCards userId="usr_1" mfaEnabled mfaMethod="totp" />);
    fireEvent.click(screen.getByRole('button', { name: 'users.mfaReset' }));
    const dialog = await screen.findByRole('dialog');
    const giveProof = await within(dialog).findByText('give-proof');
    const confirm = within(dialog).getByRole('button', { name: 'users.mfaReset' });
    fireEvent.click(confirm);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(giveProof);
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/v1/users/usr_1/mfa/reset', {
        proof: { kind: 'password', password: 'secret' },
      });
    });
  });
});

describe('UserDetailsTab fresh proof for a granting role change', () => {
  const ROLES = [
    { id: 'rol_admin00000001', name: 'admin' },
    { id: 'rol_viewer0000001', name: 'viewer' },
  ];
  const USER: UserDetailUser = {
    id: 'usr_1',
    email: 'u@example.com',
    firstName: 'U',
    lastName: 'Ser',
    phone: null,
    roleId: 'rol_viewer0000001',
    isActive: true,
    hasAllSiteAccess: true,
    siteIds: [],
    permissions: permissionCatalog.defaultsFor('viewer'),
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('asks for the proof when the new role grants permissions and sends it', async () => {
    api.patch.mockResolvedValue(USER);
    wrap(<UserDetailsTab user={USER} userId="usr_1" roles={ROLES} canAdminister />);
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    fireEvent.change(await screen.findByLabelText('users.role'), {
      target: { value: 'rol_admin00000001' },
    });
    fireEvent.click(await screen.findByText('give-proof'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.patch).toHaveBeenCalled();
    });
    const body = api.patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['roleId']).toBe('rol_admin00000001');
    expect(body['proof']).toEqual({ kind: 'password', password: 'secret' });
  });

  it('asks for the proof to change the phone of an admin or reactivate one', async () => {
    const admin: UserDetailUser = {
      ...USER,
      roleId: 'rol_admin00000001',
      permissions: permissionCatalog.defaultsFor('admin'),
    };
    api.patch.mockResolvedValue(admin);
    wrap(<UserDetailsTab user={admin} userId="usr_1" roles={ROLES} canAdminister />);
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    expect(screen.queryByText('give-proof')).toBeNull();
    fireEvent.change(await screen.findByPlaceholderText('users.phonePlaceholder'), {
      target: { value: '+12015550177' },
    });
    fireEvent.click(await screen.findByText('give-proof'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.patch).toHaveBeenCalled();
    });
    const body = api.patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['phone']).toBe('+12015550177');
    expect(body['proof']).toEqual({ kind: 'password', password: 'secret' });
    cleanup();

    wrap(
      <UserDetailsTab
        user={{ ...admin, isActive: false }}
        userId="usr_1"
        roles={ROLES}
        canAdminister
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    expect(screen.queryByText('give-proof')).toBeNull();
    fireEvent.click(document.getElementById('edit-active') as HTMLInputElement);
    expect(await screen.findByText('give-proof')).toBeTruthy();
  });

  it('asks no proof when the role does not change', () => {
    api.patch.mockResolvedValue(USER);
    wrap(<UserDetailsTab user={USER} userId="usr_1" roles={ROLES} canAdminister />);
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    expect(screen.queryByText('give-proof')).toBeNull();
  });
});
