// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  AVATAR_LICENSE_TEXT,
  AVATAR_NONE_VALUE,
  AVATAR_MAX_BYTES,
  avatarColorShown,
  avatarFileProblem,
  avatarOptionChoices,
  avatarVariantHasNone,
  avatarVariantSelection,
  withAvatarVariantSelection,
  checkedGeneratedAvatarDataUri,
  editableGeneratedAvatar,
  generatedAvatarProblem,
  humanizeAvatarValue,
  postAvatarUpload,
  randomGeneratedAvatar,
  renderGeneratedAvatarDataUri,
  renderGeneratedAvatarSvg,
} from '../account-avatar.js';
import type { GeneratedAvatar } from '../account-avatar.js';

function avatar(options: Record<string, string | number> = {}, seed = 'abc'): GeneratedAvatar {
  return { style: 'avataaars', seed, options };
}

/** A deterministic random source (mulberry32). */
function seeded(start: number): () => number {
  let a = start;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('avatarOptionChoices', () => {
  it('lists the variants, toggles, palettes, background and flip', () => {
    const keys = avatarOptionChoices().map((c) => c.key);
    expect(keys).toContain('topVariant');
    expect(keys).toContain('accessoriesProbability');
    expect(keys).toContain('skinColor');
    expect(keys).toContain('backgroundColor');
    expect(keys).toContain('flip');
    expect(keys).not.toContain('size');
    expect(keys).not.toContain('noseVariant');
  });

  it('accepts every listed value', () => {
    for (const choice of avatarOptionChoices()) {
      const values: Array<string | number> = choice.kind === 'toggle' ? [0, 100] : choice.values;
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(generatedAvatarProblem(avatar({ [choice.key]: value }))).toBeNull();
      }
    }
  });

  it('returns a copy each time', () => {
    const first = avatarOptionChoices();
    first[0]?.values.push('evil');
    expect(avatarOptionChoices()[0]?.values).not.toContain('evil');
  });
});

describe('generatedAvatarProblem', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['another style', { style: 'bottts', seed: 'a', options: {} }],
    ['an extra field', { style: 'avataaars', seed: 'a', options: {}, size: 64 }],
    ['a long seed', avatar({}, 'a'.repeat(65))],
    ['a seed with markup', avatar({}, '<svg>')],
    ['an empty seed', avatar({}, '')],
    ['options as an array', { style: 'avataaars', seed: 'a', options: [] }],
    ['size', avatar({ size: 64 })],
    ['translateX', avatar({ translateX: 10 })],
    ['title', avatar({ title: 'x' })],
    ['an unknown key', avatar({ hackVariant: 'x' })],
    ['an unknown enum value', avatar({ topVariant: 'nope' })],
    ['a color with a hash', avatar({ skinColor: '#614335' })],
    ['an upper-case color', avatar({ skinColor: 'D08B5B' })],
    ['a color outside the palette', avatar({ skinColor: '000000' })],
    ['a background that is not hex', avatar({ backgroundColor: 'red' })],
    ['a list value', avatar({ topVariant: ['bob'] as unknown as string })],
    ['a probability between the values', avatar({ topProbability: 50 })],
    ['a probability as text', avatar({ topProbability: '100' })],
    ['a flip outside the list', avatar({ flip: 'both' })],
  ])('refuses %s', (_name, input) => {
    expect(generatedAvatarProblem(input)).not.toBeNull();
  });

  it('accepts any background color', () => {
    expect(generatedAvatarProblem(avatar({ backgroundColor: '123abc' }))).toBeNull();
  });

  it('refuses a body larger than the cap', () => {
    const big = avatar({}, 'a');
    (big as unknown as Record<string, unknown>)['options'] = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`topVariant${String(i)}`, 'bob']),
    );
    expect(generatedAvatarProblem(big)).toMatch(/too large|Unknown/);
  });
});

describe('rendering', () => {
  it('returns a deterministic SVG data URI', () => {
    const input = avatar({ topVariant: 'bob', skinColor: 'd08b5b' });
    const uri = renderGeneratedAvatarDataUri(input);
    expect(uri.startsWith('data:image/svg+xml')).toBe(true);
    expect(renderGeneratedAvatarDataUri(input)).toBe(uri);
    expect(renderGeneratedAvatarSvg(input)).toContain('#d08b5b');
  });

  it('names the Avataaars licence', () => {
    expect(AVATAR_LICENSE_TEXT).toContain('Pablo Stanley');
  });
});

describe('checkedGeneratedAvatarDataUri', () => {
  it('renders an avatar on the allow-list like renderGeneratedAvatarDataUri', () => {
    const valid = avatar({ topVariant: 'bob', skinColor: '614335' });
    expect(checkedGeneratedAvatarDataUri(valid)).toBe(renderGeneratedAvatarDataUri(valid));
  });

  it('gives null for options off the allow-list, so clients show initials (I3)', () => {
    expect(checkedGeneratedAvatarDataUri(avatar({ topVariant: 'nope' }))).toBeNull();
    expect(checkedGeneratedAvatarDataUri(avatar({ backgroundColor: 'url(x)' }))).toBeNull();
    expect(checkedGeneratedAvatarDataUri(avatar({}, '<script>'))).toBeNull();
    expect(checkedGeneratedAvatarDataUri({ style: 'bottts', seed: 'a', options: {} })).toBeNull();
    expect(checkedGeneratedAvatarDataUri(null)).toBeNull();
  });
});

describe('randomGeneratedAvatar', () => {
  it('always makes a valid avatar', () => {
    const random = seeded(42);
    for (let i = 0; i < 100; i++) {
      const generated = randomGeneratedAvatar(random);
      expect(generatedAvatarProblem(generated)).toBeNull();
    }
  });

  it('changes with the random source', () => {
    expect(randomGeneratedAvatar(seeded(1))).not.toEqual(randomGeneratedAvatar(seeded(2)));
    expect(randomGeneratedAvatar(seeded(3))).toEqual(randomGeneratedAvatar(seeded(3)));
  });
});

describe('editableGeneratedAvatar', () => {
  it('starts from a saved avatar on the list, without its reply fields', () => {
    const saved = { kind: 'generated', updatedAt: 'x', ...avatar({ topVariant: 'bob' }) };
    expect(editableGeneratedAvatar(saved)).toEqual(avatar({ topVariant: 'bob' }));
  });

  it('starts from a random avatar for none, an image or one off the list', () => {
    const random = randomGeneratedAvatar(seeded(7));
    expect(editableGeneratedAvatar(null, seeded(7))).toEqual(random);
    expect(editableGeneratedAvatar({ kind: 'image', url: 'u' }, seeded(7))).toEqual(random);
    expect(editableGeneratedAvatar(avatar({ size: 9 }), seeded(7))).toEqual(random);
  });
});

describe('None in the variant dropdowns', () => {
  it('offers None for hair or headwear, glasses and facial hair only', () => {
    expect(avatarVariantHasNone('topVariant')).toBe(true);
    expect(avatarVariantHasNone('accessoriesVariant')).toBe(true);
    expect(avatarVariantHasNone('facialHairVariant')).toBe(true);
    expect(avatarVariantHasNone('eyesVariant')).toBe(false);
    expect(avatarVariantHasNone('flip')).toBe(false);
  });

  it('never collides with a variant name of an optional component', () => {
    for (const choice of avatarOptionChoices()) {
      if (avatarVariantHasNone(choice.key)) expect(choice.values).not.toContain(AVATAR_NONE_VALUE);
    }
  });

  it('shows None while the probability is 0, else the stored variant', () => {
    expect(avatarVariantSelection({ topVariant: 'bob', topProbability: 0 }, 'topVariant')).toBe(
      AVATAR_NONE_VALUE,
    );
    expect(avatarVariantSelection({ topVariant: 'bob', topProbability: 100 }, 'topVariant')).toBe(
      'bob',
    );
    expect(avatarVariantSelection({ topVariant: 'bob' }, 'topVariant')).toBe('bob');
    expect(avatarVariantSelection({}, 'accessoriesVariant')).toBe('');
    expect(avatarVariantSelection({ flip: 'none' }, 'flip')).toBe('none');
  });

  it('stores None as probability 0 and keeps the stored variant', () => {
    expect(
      withAvatarVariantSelection(
        { facialHairVariant: 'beardLight', facialHairProbability: 100 },
        'facialHairVariant',
        AVATAR_NONE_VALUE,
      ),
    ).toEqual({ facialHairVariant: 'beardLight', facialHairProbability: 0 });
  });

  it('stores a picked variant with probability 100', () => {
    expect(
      withAvatarVariantSelection(
        { accessoriesVariant: 'round', accessoriesProbability: 0 },
        'accessoriesVariant',
        'kurt',
      ),
    ).toEqual({ accessoriesVariant: 'kurt', accessoriesProbability: 100 });
  });

  it('stores other options as picked, flip none included', () => {
    expect(withAvatarVariantSelection({ flip: 'horizontal' }, 'flip', 'none')).toEqual({
      flip: 'none',
    });
    expect(withAvatarVariantSelection({}, 'eyesVariant', 'wink')).toEqual({ eyesVariant: 'wink' });
  });

  it('keeps every pick on the allow-list', () => {
    let options: Record<string, string | number> = { topVariant: 'bob', topProbability: 100 };
    options = withAvatarVariantSelection(options, 'topVariant', AVATAR_NONE_VALUE);
    expect(generatedAvatarProblem(avatar(options))).toBeNull();
    options = withAvatarVariantSelection(options, 'topVariant', 'hat');
    expect(generatedAvatarProblem(avatar(options))).toBeNull();
  });

  it('hides the colors of a component set to None', () => {
    const none = { topProbability: 0, accessoriesProbability: 0, facialHairProbability: 0 };
    for (const key of ['hairColor', 'hatColor', 'accessoriesColor', 'facialHairColor']) {
      expect(avatarColorShown(none, key)).toBe(false);
      expect(avatarColorShown({}, key)).toBe(true);
    }
    expect(avatarColorShown(none, 'skinColor')).toBe(true);
    expect(avatarColorShown(none, 'backgroundColor')).toBe(true);
    expect(avatarColorShown({ topProbability: 0 }, 'facialHairColor')).toBe(true);
  });

  it('lets Random pick None', () => {
    const random = seeded(11);
    const picks = Array.from({ length: 50 }, () =>
      avatarVariantSelection(randomGeneratedAvatar(random).options, 'accessoriesVariant'),
    );
    expect(picks).toContain(AVATAR_NONE_VALUE);
    expect(picks.some((p) => p !== AVATAR_NONE_VALUE)).toBe(true);
  });
});

describe('humanizeAvatarValue', () => {
  it('turns DiceBear value names into labels', () => {
    expect(humanizeAvatarValue('shortFlat')).toBe('Short Flat');
    expect(humanizeAvatarValue('prescription01')).toBe('Prescription 01');
  });
});

describe('avatarFileProblem', () => {
  it('accepts JPEG, PNG and WebP smaller than 1 MB only', () => {
    expect(AVATAR_MAX_BYTES).toBe(1_048_575);
    expect(avatarFileProblem({ type: 'image/jpeg', size: 1_048_575 })).toBeNull();
    expect(avatarFileProblem({ type: 'image/webp', size: 1 })).toBeNull();
    expect(avatarFileProblem({ type: 'image/png', size: 1_048_576 })).toBe('too_large');
    expect(avatarFileProblem({ type: 'image/svg+xml', size: 10 })).toBe('wrong_type');
    expect(avatarFileProblem({ type: 'image/gif', size: 10 })).toBe('wrong_type');
  });
});

describe('postAvatarUpload', () => {
  const ticket = {
    uploadUrl: 'https://s3.test/b',
    fields: { key: 'k', Policy: 'p' },
    s3Key: 'k',
    s3Bucket: 'b',
  };

  it('posts the policy fields first and the file last', async () => {
    let sent: FormData | null = null;
    const fetchImpl = ((_url: string, init: { body: FormData }) => {
      sent = init.body;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    await postAvatarUpload(ticket, new Blob(['x'], { type: 'image/png' }), fetchImpl);
    expect([...(sent as unknown as FormData).keys()]).toEqual(['key', 'Policy', 'file']);
  });

  it('throws when storage refuses the upload', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response(null, { status: 403 }))) as unknown as typeof fetch;
    await expect(postAvatarUpload(ticket, new Blob(['x']), fetchImpl)).rejects.toThrow('403');
  });
});
