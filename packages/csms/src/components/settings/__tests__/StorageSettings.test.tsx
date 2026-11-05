// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && typeof opts.provider === 'string' ? `${key}(${opts.provider})` : key,
    i18n: { language: 'en' },
  }),
}));
// Imported by the other integration tabs; only the storage tab renders here.
vi.mock('@/lib/auth', () => ({
  useHasPermission: () => true,
  useHasAllSiteAccess: () => true,
  useHasCompanyWidePermission: () => true,
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

// The proof field has its own tests: here it hands back a password proof.
vi.mock('@/components/FactorProofField', () => ({
  FactorProofField: ({
    onChange,
    showMissing,
  }: {
    onChange: (proof: { kind: string; password: string }) => void;
    showMissing: boolean;
  }) => (
    <button
      type="button"
      data-testid="storage-proof"
      data-missing={String(showMissing)}
      onClick={() => {
        onChange({ kind: 'password', password: 'pw' });
      }}
    >
      proof
    </button>
  ),
  proofRejection: () => ({ code: null }),
}));

import { ApiError } from '@/lib/api';
import { IntegrationsSettings } from '../IntegrationsSettings';

const ACCOUNT = '0123456789abcdef0123456789abcdef';

const AWS_SETTINGS = {
  's3.provider': 's3',
  's3.bucket': 'my-bucket',
  's3.region': 'us-east-1',
  's3.accessKeyIdEnc': 'AKIA123',
  's3.secretAccessKeyEnc': 'secret123',
};

const KEYS = { 's3.accessKeyIdEnc': 'AKIA123', 's3.secretAccessKeyEnc': 'secret123' };

function renderStorage(settings: Record<string, unknown>, search = '?sub=storage'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // useTab builds the next URL from window.location, so it starts at the same address.
  window.history.replaceState({}, '', `/settings${search}`);
  render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <QueryClientProvider client={client}>
        <IntegrationsSettings settings={settings} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function panel(tab: string): HTMLElement {
  return screen.getByTestId(`storage-tab-${tab}`);
}

function openTab(name: string): void {
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(`settings.storage.${name}`) }));
}

function field(tab: string, name: string): HTMLInputElement {
  const el = document.getElementById(`storage-${tab}-${name}`);
  if (el == null) throw new Error(`no field storage-${tab}-${name}`);
  return el as HTMLInputElement;
}

function type(tab: string, name: string, value: string): void {
  fireEvent.change(field(tab, name), { target: { value } });
}

function saveButton(tab: string): HTMLButtonElement {
  return within(panel(tab)).getByRole('button', { name: /save/i });
}

function save(tab: string): void {
  fireEvent.click(saveButton(tab));
}

function lastBody(): Record<string, unknown> {
  return apiMock.put.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

/** GET /v1/users/me/mfa answers these proof kinds; other GETs answer {}. */
function proofKinds(kinds: string[]): void {
  apiMock.get.mockImplementation((url: string) =>
    Promise.resolve(url === '/v1/users/me/mfa' ? { factorProofKinds: kinds, mfaMethod: null } : {}),
  );
}

beforeEach(() => {
  proofKinds([]);
  apiMock.put.mockResolvedValue({ success: true });
  apiMock.post.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Storage settings tabs', () => {
  it('opens from the old s3 sub tab id and shows the stored provider tab as active', () => {
    renderStorage(AWS_SETTINGS, '?sub=s3');
    expect(
      screen.getByRole('tab', { name: /settings.storage.title/ }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByTestId('storage-active-aws')).toBeTruthy();
    expect(screen.queryByTestId('storage-active-r2')).toBeNull();
    expect(panel('aws').hidden).toBe(false);
    expect(within(panel('aws')).getByTestId('storage-status-aws').textContent).toBe(
      'settings.storage.statusActive(settings.storage.providerAws)',
    );
  });

  it('falls back to the stored provider tab for an unknown tab id', () => {
    renderStorage(AWS_SETTINGS, '?sub=storage&storage=nope');
    expect(panel('aws').hidden).toBe(false);
  });

  it('opens a provider tab from its deep link', () => {
    renderStorage(AWS_SETTINGS, '?sub=storage&storage=r2');
    expect(panel('r2').hidden).toBe(false);
    expect(within(panel('r2')).getByTestId('storage-status-r2').textContent).toContain(
      'settings.storage.statusOther',
    );
  });

  it('says storage is not set up while no bucket is stored, and shows no active badge', () => {
    renderStorage({});
    expect(screen.queryByTestId('storage-active-aws')).toBeNull();
    expect(within(panel('aws')).getByTestId('storage-status-aws').textContent).toBe(
      'settings.storage.statusNone(settings.storage.providerAws)',
    );
  });

  it('shows each tab only its own fields', () => {
    renderStorage(AWS_SETTINGS);
    // AWS S3: a region select, no endpoint, no account ID.
    expect(field('aws', 'region').tagName).toBe('SELECT');
    expect(document.getElementById('storage-aws-endpoint')).toBeNull();
    // R2: account ID and jurisdiction, no region and no endpoint URL.
    expect(field('r2', 'account-id')).toBeTruthy();
    expect(field('r2', 'jurisdiction').tagName).toBe('SELECT');
    expect(document.getElementById('storage-r2-region')).toBeNull();
    expect(document.getElementById('storage-r2-endpoint')).toBeNull();
    // Wasabi: a region select, no endpoint and no path-style or private hosts.
    expect(field('wasabi', 'region').tagName).toBe('SELECT');
    expect(document.getElementById('storage-wasabi-endpoint')).toBeNull();
    expect(document.getElementById('storage-wasabi-path-style')).toBeNull();
    // S3-compatible: endpoint, free region, path-style.
    expect(field('compatible', 'endpoint')).toBeTruthy();
    expect(field('compatible', 'region').tagName).toBe('INPUT');
    expect(field('compatible', 'path-style')).toBeTruthy();
  });

  it('keeps each tab edits when another tab opens', () => {
    renderStorage(AWS_SETTINGS);
    type('aws', 'bucket', 'edited-bucket');
    openTab('providerCompatible');
    type('compatible', 'endpoint', 'https://minio.example.com');
    openTab('providerAws');
    expect(field('aws', 'bucket').value).toBe('edited-bucket');
    expect(field('compatible', 'endpoint').value).toBe('https://minio.example.com');
  });

  it('shows no stored key in another provider tab', () => {
    renderStorage(AWS_SETTINGS);
    expect(field('aws', 'access-key').value).toBe('AKIA123');
    expect(field('r2', 'access-key').value).toBe('');
    expect(field('wasabi', 'secret-key').value).toBe('');
    expect(field('compatible', 'bucket').value).toBe('');
  });

  it('offers Test Connection on the active tab only', () => {
    renderStorage(AWS_SETTINGS);
    within(panel('aws')).getByRole('button', { name: /settings.storage.test$/ });
    openTab('providerR2');
    expect(
      within(panel('r2')).queryByRole('button', { name: /settings.storage.test$/ }),
    ).toBeNull();
  });
});

describe('Amazon S3 tab', () => {
  it('saves the region from the list and leaves out keys the user did not edit', async () => {
    renderStorage(AWS_SETTINGS);
    type('aws', 'region', 'eu-central-1');
    save('aws');
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/s3', {
        provider: 's3',
        bucket: 'my-bucket',
        region: 'eu-central-1',
      });
    });
  });

  it('sends an edited secret only', async () => {
    renderStorage(AWS_SETTINGS);
    type('aws', 'secret-key', 'typed-secret');
    save('aws');
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalled();
    });
    expect(lastBody().secretAccessKey).toBe('typed-secret');
    expect(lastBody()).not.toHaveProperty('accessKeyId');
  });

  it('needs a region', () => {
    renderStorage(AWS_SETTINGS);
    type('aws', 'region', '');
    expect(saveButton('aws').disabled).toBe(true);
  });

  it('keeps a stored region that is not in the list selectable', () => {
    renderStorage({ ...AWS_SETTINGS, 's3.region': 'xx-new-1' });
    expect(field('aws', 'region').value).toBe('xx-new-1');
  });

  it('shows the IAM policy and CORS guides', () => {
    renderStorage(AWS_SETTINGS);
    const setup = within(panel('aws')).getByTestId('storage-setup-aws');
    within(setup).getByText('settings.storage.awsPolicyTitle');
    within(setup).getByText('settings.storage.corsTitle');
  });
});

describe('Cloudflare R2 tab', () => {
  const R2 = {
    ...KEYS,
    's3.provider': 'r2',
    's3.bucket': 'files',
    's3.region': 'auto',
    's3.endpoint': `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
    's3.forcePathStyle': true,
  };

  it('loads the account ID and jurisdiction from the stored S3 API URL', () => {
    renderStorage(R2);
    expect(screen.getByTestId('storage-active-r2')).toBeTruthy();
    expect(field('r2', 'account-id').value).toBe(ACCOUNT);
    expect(field('r2', 'jurisdiction').value).toBe('eu');
    expect(within(panel('r2')).getByTestId('storage-r2-endpoint').textContent).toBe(
      'settings.storage.r2EndpointBuilt',
    );
  });

  it('saves the S3 API URL built from the account ID and jurisdiction, without a region', async () => {
    renderStorage(R2);
    type('r2', 'bucket', 'other-files');
    save('r2');
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/s3', {
        provider: 'r2',
        bucket: 'other-files',
        endpoint: `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
      });
    });
  });

  it('builds the default, FedRAMP and US URLs and sends both keys for a new account', async () => {
    renderStorage(AWS_SETTINGS, '?sub=storage&storage=r2');
    type('r2', 'account-id', ACCOUNT.toUpperCase());
    type('r2', 'bucket', 'files');
    type('r2', 'access-key', 'r2-key');
    type('r2', 'secret-key', 'r2-secret');
    save('r2');
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalled();
    });
    expect(lastBody()).toEqual({
      provider: 'r2',
      bucket: 'files',
      endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      accessKeyId: 'r2-key',
      secretAccessKey: 'r2-secret',
    });
    type('r2', 'jurisdiction', 'fedramp');
    save('r2');
    await waitFor(() => {
      expect(lastBody().endpoint).toBe(`https://${ACCOUNT}.fedramp.r2.cloudflarestorage.com`);
    });
    type('r2', 'jurisdiction', 'us');
    save('r2');
    await waitFor(() => {
      expect(lastBody().endpoint).toBe(`https://${ACCOUNT}.us.r2.cloudflarestorage.com`);
    });
  });

  it('refuses an account ID that is not 32 hexadecimal characters', () => {
    renderStorage(R2);
    type('r2', 'account-id', 'not-an-account');
    within(panel('r2')).getByText('settings.storage.r2AccountIdInvalid');
    expect(saveButton('r2').disabled).toBe(true);
  });

  it('shows the token steps, the PUT CORS rule and the image origin', () => {
    renderStorage(R2);
    const setup = within(panel('r2')).getByTestId('storage-setup-r2');
    within(setup).getByText('settings.storage.r2TokenTitle');
    expect(within(setup).getByTestId('storage-cors-example').textContent).toContain('"PUT"');
    expect(within(setup).getByTestId('storage-image-origin').textContent).toContain(
      `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
    );
  });

  it('says why a refused account ID was not saved', async () => {
    apiMock.put.mockRejectedValue(
      new ApiError(400, { error: 'x', code: 'VALIDATION_ERROR', field: 'endpoint' }),
    );
    renderStorage(R2);
    save('r2');
    await within(panel('r2')).findByText('settings.storage.r2EndpointRefused');
  });
});

describe('Wasabi tab', () => {
  const WASABI = {
    ...KEYS,
    's3.provider': 's3-compatible',
    's3.bucket': 'files',
    's3.region': 'eu-central-2',
    's3.endpoint': 'https://s3.eu-central-2.wasabisys.com',
    's3.forcePathStyle': false,
    's3.allowedPrivateHosts': [],
  };

  it('opens for a stored Wasabi service URL and saves the region with its service URL', async () => {
    renderStorage(WASABI);
    expect(screen.getByTestId('storage-active-wasabi')).toBeTruthy();
    expect(field('wasabi', 'region').value).toBe('eu-central-2');
    type('wasabi', 'bucket', 'more-files');
    save('wasabi');
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/s3', {
        provider: 's3-compatible',
        bucket: 'more-files',
        region: 'eu-central-2',
        endpoint: 'https://s3.eu-central-2.wasabisys.com',
        // The stored path-style choice stays.
        forcePathStyle: false,
        allowedPrivateHosts: [],
      });
    });
  });

  it('keeps the region-less us-east-1 service URL while the region stays', async () => {
    proofKinds(['password']);
    renderStorage({
      ...WASABI,
      's3.region': '',
      's3.endpoint': 'https://s3.wasabisys.com',
    });
    expect(field('wasabi', 'region').value).toBe('us-east-1');
    save('wasabi');
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalled();
    });
    expect(lastBody().endpoint).toBe('https://s3.wasabisys.com');
    expect(lastBody()).not.toHaveProperty('proof');
    expect(lastBody()).not.toHaveProperty('accessKeyId');
  });

  it('asks for the proof and both keys when the region moves to another service URL', async () => {
    proofKinds(['password']);
    renderStorage(WASABI);
    type('wasabi', 'region', 'ap-southeast-1');
    const proof = await within(panel('wasabi')).findByTestId('storage-proof');
    fireEvent.click(proof);
    save('wasabi');
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalled();
    });
    expect(lastBody()).toMatchObject({
      endpoint: 'https://s3.ap-southeast-1.wasabisys.com',
      region: 'ap-southeast-1',
      accessKeyId: 'AKIA123',
      secretAccessKey: 'secret123',
      proof: { kind: 'password', password: 'pw' },
    });
  });

  it('starts a new Wasabi setup with path-style requests and needs a region', async () => {
    renderStorage(AWS_SETTINGS, '?sub=storage&storage=wasabi');
    type('wasabi', 'bucket', 'files');
    type('wasabi', 'access-key', 'w-key');
    type('wasabi', 'secret-key', 'w-secret');
    expect(saveButton('wasabi').disabled).toBe(true);
    type('wasabi', 'region', 'us-west-1');
    save('wasabi');
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalled();
    });
    expect(lastBody()).toMatchObject({
      provider: 's3-compatible',
      endpoint: 'https://s3.us-west-1.wasabisys.com',
      forcePathStyle: true,
      allowedPrivateHosts: [],
    });
    expect(within(panel('wasabi')).getByTestId('storage-image-origin').textContent).toContain(
      'https://s3.us-west-1.wasabisys.com',
    );
  });
});

describe('S3-compatible tab', () => {
  const MINIO = {
    ...KEYS,
    's3.provider': 's3-compatible',
    's3.bucket': 'my-bucket',
    's3.region': '',
    's3.endpoint': 'http://minio.internal:9000',
    's3.forcePathStyle': true,
    's3.allowedPrivateHosts': ['minio.internal'],
  };

  it('loads and saves the endpoint, path-style choice and private hosts', async () => {
    renderStorage(MINIO);
    expect(screen.getByTestId('storage-active-compatible')).toBeTruthy();
    expect(field('compatible', 'endpoint').value).toBe('http://minio.internal:9000');
    expect(field('compatible', 'path-style').checked).toBe(true);
    expect(
      within(panel('compatible'))
        .getByTestId('storage-advanced')
        .querySelector('[data-collapsible-summary]')?.textContent,
    ).toBe('settings.storage.advancedPrivateHosts');
    fireEvent.click(
      within(panel('compatible')).getByRole('button', { name: /settings.storage.advanced/ }),
    );
    type('compatible', 'allowed-hosts', 'minio.internal\n 10.0.0.5 \n');
    save('compatible');
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/s3', {
        provider: 's3-compatible',
        bucket: 'my-bucket',
        region: '',
        endpoint: 'http://minio.internal:9000',
        forcePathStyle: true,
        allowedPrivateHosts: ['minio.internal', '10.0.0.5'],
      });
    });
  });

  it('shows the image origin of the bucket host when path-style requests are off', () => {
    renderStorage(MINIO);
    fireEvent.click(field('compatible', 'path-style'));
    expect(within(panel('compatible')).getByTestId('storage-image-origin').textContent).toContain(
      'http://my-bucket.minio.internal:9000',
    );
  });

  it('needs an endpoint', () => {
    renderStorage(MINIO);
    type('compatible', 'endpoint', ' ');
    expect(saveButton('compatible').disabled).toBe(true);
  });

  it('says why a refused endpoint or private hosts list was not saved', async () => {
    apiMock.put.mockRejectedValueOnce(new ApiError(400, { error: 'x', code: 'PRIVATE_URL' }));
    renderStorage(MINIO);
    save('compatible');
    await within(panel('compatible')).findByText('settings.storage.endpointRefused');
    apiMock.put.mockRejectedValueOnce(
      new ApiError(400, { error: 'x', code: 'VALIDATION_ERROR', field: 'allowedPrivateHosts' }),
    );
    save('compatible');
    await within(panel('compatible')).findByText('settings.storage.allowedHostsRefused');
  });

  it('shows the generic message for other save errors', async () => {
    apiMock.put.mockRejectedValue(new Error('boom'));
    renderStorage(MINIO);
    save('compatible');
    await within(panel('compatible')).findByText('settings.storage.saveFailed');
  });
});

describe('switching the provider', () => {
  beforeEach(() => {
    proofKinds(['password']);
  });

  it('labels Save as switching, asks for the proof and sends both keys', async () => {
    renderStorage(AWS_SETTINGS);
    openTab('providerCompatible');
    type('compatible', 'endpoint', 'https://storage.example.com');
    type('compatible', 'bucket', 'b');
    type('compatible', 'access-key', 'k');
    type('compatible', 'secret-key', 's');
    expect(saveButton('compatible').textContent).toContain(
      'settings.storage.saveAndUse(settings.storage.providerCompatible)',
    );
    const proof = await within(panel('compatible')).findByTestId('storage-proof');
    save('compatible');
    expect(apiMock.put).not.toHaveBeenCalled();
    expect(proof.getAttribute('data-missing')).toBe('true');
    fireEvent.click(proof);
    save('compatible');
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalled();
    });
    expect(lastBody()).toEqual({
      proof: { kind: 'password', password: 'pw' },
      provider: 's3-compatible',
      bucket: 'b',
      region: '',
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpoint: 'https://storage.example.com',
      forcePathStyle: true,
      allowedPrivateHosts: [],
    });
  });

  it('needs the keys of the new provider before Save', () => {
    renderStorage(AWS_SETTINGS, '?sub=storage&storage=compatible');
    type('compatible', 'endpoint', 'https://storage.example.com');
    type('compatible', 'bucket', 'b');
    expect(saveButton('compatible').disabled).toBe(true);
  });

  it('asks for no proof on the active tab while the destination stays', () => {
    renderStorage(AWS_SETTINGS);
    type('aws', 'bucket', 'other');
    expect(within(panel('aws')).queryByTestId('storage-proof')).toBeNull();
  });
});
