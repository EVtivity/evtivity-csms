// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Avatar, OptionsDescriptor, Style } from '@dicebear/core';
import avataaars from '@dicebear/styles/avataaars.json' with { type: 'json' };

/**
 * Generated driver avatars (DiceBear Avataaars). A driver either builds one of
 * these or uploads an image; this module holds the option allow-list shared by
 * the API (validation) and the frontends (pickers and rendering).
 *
 * Rendering only goes through `toDataUri()` into an `<img src>`, never into
 * markup, so even a value that got past the validation cannot reach the DOM as
 * HTML.
 */

export interface GeneratedAvatar {
  style: 'avataaars';
  seed: string;
  options: Record<string, string | number>;
}

export const AVATAR_STYLE = 'avataaars';
export const AVATAR_SEED_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Largest stored `avatar_options` JSON, in characters. */
export const AVATAR_OPTIONS_MAX_JSON = 4096;

/** "Remix of Avataaars by Pablo Stanley", the attribution the style's licence asks for. */
export const AVATAR_LICENSE_TEXT: string = avataaars.meta.license.text;

export type AvatarChoiceKind = 'enum' | 'color' | 'toggle';

export interface AvatarOptionChoice {
  /** The DiceBear option name, such as `topVariant` or `skinColor`. */
  key: string;
  kind: AvatarChoiceKind;
  /** Enum values, or colors as six lowercase hex digits without `#`. Empty for a toggle. */
  values: string[];
}

// The components a driver picks a variant of. `nose` has one variant only.
const VARIANT_COMPONENTS = [
  'top',
  'accessories',
  'eyebrows',
  'eyes',
  'mouth',
  'facialHair',
  'clothes',
  'clothesGraphic',
] as const;

// Components that may be left out: a toggle stores 0 (hidden) or 100 (shown).
const TOGGLE_COMPONENTS = ['top', 'accessories', 'facialHair'] as const;

// Color options and the style palette each one is drawn from.
const COLOR_PALETTES = {
  skinColor: avataaars.colors.skin.values,
  hairColor: avataaars.colors.hair.values,
  facialHairColor: avataaars.colors.facialHair.values,
  clothesColor: avataaars.colors.clothes.values,
  hatColor: avataaars.colors.hat.values,
  accessoriesColor: avataaars.colors.accessories.values,
} as const;

/** Backgrounds the pickers offer. The style has no background palette, so any color is accepted. */
const BACKGROUND_CHOICES = ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf', 'e5e7eb'];

const FLIP_VALUES = ['none', 'horizontal'];

const HEX_COLOR = /^[0-9a-f]{6}$/;

let cachedStyle: Style | null = null;
function avatarStyle(): Style {
  cachedStyle ??= new Style<unknown>(avataaars);
  return cachedStyle;
}

let cachedChoices: AvatarOptionChoice[] | null = null;

/**
 * Every option a driver can set, read from the style's options descriptor:
 * one enum per component variant, one color per palette, plus background,
 * flip and the toggles. Built once.
 */
export function avatarOptionChoices(): AvatarOptionChoice[] {
  if (cachedChoices != null) return cachedChoices.map((c) => ({ ...c, values: [...c.values] }));
  const descriptor = new OptionsDescriptor(avatarStyle()).toJSON();
  const choices: AvatarOptionChoice[] = [];
  for (const component of VARIANT_COMPONENTS) {
    const field = descriptor[`${component}Variant`];
    if (field?.type !== 'enum') throw new Error(`avatar style has no ${component} variants`);
    choices.push({ key: `${component}Variant`, kind: 'enum', values: [...field.values] });
  }
  for (const component of TOGGLE_COMPONENTS) {
    if (descriptor[`${component}Probability`]?.type !== 'number') {
      throw new Error(`avatar style has no ${component} probability`);
    }
    choices.push({ key: `${component}Probability`, kind: 'toggle', values: [] });
  }
  for (const [key, palette] of Object.entries(COLOR_PALETTES)) {
    if (descriptor[key]?.type !== 'color') throw new Error(`avatar style has no ${key}`);
    choices.push({ key, kind: 'color', values: palette.map((c) => c.replace('#', '')) });
  }
  choices.push({ key: 'backgroundColor', kind: 'color', values: [...BACKGROUND_CHOICES] });
  choices.push({ key: 'flip', kind: 'enum', values: [...FLIP_VALUES] });
  cachedChoices = choices;
  return avatarOptionChoices();
}

/**
 * Why `input` is not a storable generated avatar, or null when it is. Refuses
 * unknown keys at every level (size, translate, rotate, scale, title,
 * idRandomization and every other DiceBear option included), lists, values
 * off the allow-list and a body above `AVATAR_OPTIONS_MAX_JSON`.
 */
export function generatedAvatarProblem(input: unknown): string | null {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return 'The avatar must be an object';
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'style' && key !== 'seed' && key !== 'options')
      return `Unknown avatar field ${key}`;
  }
  if (record['style'] !== AVATAR_STYLE) return `The avatar style must be ${AVATAR_STYLE}`;
  const seed = record['seed'];
  if (typeof seed !== 'string' || !AVATAR_SEED_PATTERN.test(seed)) {
    return 'The seed must be 1 to 64 letters, digits, hyphens or underscores';
  }
  const options = record['options'];
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    return 'The avatar options must be an object';
  }
  if (JSON.stringify(input).length > AVATAR_OPTIONS_MAX_JSON) return 'The avatar is too large';
  const choices = new Map(avatarOptionChoices().map((c) => [c.key, c]));
  for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
    const choice = choices.get(key);
    if (choice == null) return `Unknown avatar option ${key}`;
    if (choice.kind === 'toggle') {
      if (value !== 0 && value !== 100) return `${key} must be 0 or 100`;
      continue;
    }
    if (typeof value !== 'string') return `${key} must be a string`;
    if (choice.kind === 'color') {
      if (!HEX_COLOR.test(value)) return `${key} must be six lowercase hex digits`;
      if (key !== 'backgroundColor' && !choice.values.includes(value)) {
        return `${key} is not one of the style colors`;
      }
      continue;
    }
    if (!choice.values.includes(value)) return `${key} has an unknown value`;
  }
  return null;
}

/** The DiceBear options of a stored avatar: colors get their `#`. */
function dicebearOptions(avatar: GeneratedAvatar): Record<string, unknown> {
  const options: Record<string, unknown> = { seed: avatar.seed };
  for (const [key, value] of Object.entries(avatar.options)) {
    options[key] = typeof value === 'string' && key.endsWith('Color') ? `#${value}` : value;
  }
  return options;
}

/** The SVG markup of a generated avatar. For renderers that take SVG text (React Native `SvgXml`). */
export function renderGeneratedAvatarSvg(avatar: GeneratedAvatar): string {
  return new Avatar(avatarStyle(), dicebearOptions(avatar)).toString();
}

/** A `data:image/svg+xml` URI of a generated avatar, for an `<img src>`. Deterministic. */
export function renderGeneratedAvatarDataUri(avatar: GeneratedAvatar): string {
  return new Avatar(avatarStyle(), dicebearOptions(avatar)).toDataUri();
}

/**
 * The data URI of a generated avatar a client received, or null when it is not
 * on the allow-list (`generatedAvatarProblem`): clients render only checked
 * options and show initials otherwise, whatever the server sent.
 */
export function checkedGeneratedAvatarDataUri(input: unknown): string | null {
  if (generatedAvatarProblem(input) != null) return null;
  try {
    return renderGeneratedAvatarDataUri(input as GeneratedAvatar);
  } catch {
    // fail-open: an avatar DiceBear cannot render shows initials instead
    return null;
  }
}

const SEED_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function pick<T>(values: readonly T[], random: () => number): T {
  const value = values[Math.floor(random() * values.length) % values.length];
  if (value === undefined) throw new Error('no values to pick from');
  return value;
}

/** A random avatar with every option set, as the Random button makes. */
export function randomGeneratedAvatar(random: () => number = Math.random): GeneratedAvatar {
  let seed = '';
  for (let i = 0; i < 16; i++)
    seed += SEED_ALPHABET.charAt(Math.floor(random() * SEED_ALPHABET.length));
  const options: Record<string, string | number> = {};
  for (const choice of avatarOptionChoices()) {
    if (choice.key === 'flip') {
      options[choice.key] = 'none';
    } else if (choice.kind === 'toggle') {
      const shownShare =
        choice.key === 'topProbability'
          ? 0.95
          : choice.key === 'accessoriesProbability'
            ? 0.3
            : 0.2;
      options[choice.key] = random() < shownShare ? 100 : 0;
    } else {
      options[choice.key] = pick(choice.values, random);
    }
  }
  return { style: AVATAR_STYLE, seed, options };
}

/**
 * A saved avatar to start an editor from, or a random one when there is none
 * or it is off the allow-list (an avatar off the list is never edited further).
 */
export function editableGeneratedAvatar(
  current: unknown,
  random: () => number = Math.random,
): GeneratedAvatar {
  if (current != null && typeof current === 'object') {
    const { style, seed, options } = current as Record<string, unknown>;
    const candidate = { style, seed, options };
    if (generatedAvatarProblem(candidate) == null) {
      const valid = candidate as GeneratedAvatar;
      return { style: valid.style, seed: valid.seed, options: { ...valid.options } };
    }
  }
  return randomGeneratedAvatar(random);
}

/**
 * The dropdown value meaning "leave this component out" (No Hair or Headwear,
 * No Glasses, No Facial Hair). It is never stored: it maps to the component's
 * probability 0. No variant of an optional component has this name.
 */
export const AVATAR_NONE_VALUE = 'none';

/** Variant options whose dropdown offers None, and the probability each one maps to. */
const OPTIONAL_VARIANTS: Readonly<Record<string, string>> = {
  topVariant: 'topProbability',
  accessoriesVariant: 'accessoriesProbability',
  facialHairVariant: 'facialHairProbability',
};

/** Color options that apply only while their component is shown. */
const COLOR_COMPONENT: Readonly<Record<string, string>> = {
  hairColor: 'topVariant',
  hatColor: 'topVariant',
  accessoriesColor: 'accessoriesVariant',
  facialHairColor: 'facialHairVariant',
};

/** True when the dropdown of `variantKey` offers None as its first option. */
export function avatarVariantHasNone(variantKey: string): boolean {
  return Object.hasOwn(OPTIONAL_VARIANTS, variantKey);
}

/**
 * The dropdown value of a variant option: `AVATAR_NONE_VALUE` while the
 * component's probability is 0, else the stored variant ('' when unset).
 */
export function avatarVariantSelection(
  options: Readonly<Record<string, string | number>>,
  variantKey: string,
): string {
  const probabilityKey = OPTIONAL_VARIANTS[variantKey];
  if (probabilityKey !== undefined && options[probabilityKey] === 0) return AVATAR_NONE_VALUE;
  const value = options[variantKey];
  return typeof value === 'string' ? value : '';
}

/**
 * The options after a dropdown pick. None stores the probability 0 and keeps
 * the stored variant; a variant of an optional component stores it with the
 * probability 100; any other option stores the value as picked.
 */
export function withAvatarVariantSelection(
  options: Readonly<Record<string, string | number>>,
  variantKey: string,
  value: string,
): Record<string, string | number> {
  const probabilityKey = OPTIONAL_VARIANTS[variantKey];
  if (probabilityKey === undefined) return { ...options, [variantKey]: value };
  if (value === AVATAR_NONE_VALUE) return { ...options, [probabilityKey]: 0 };
  return { ...options, [variantKey]: value, [probabilityKey]: 100 };
}

/** False for a color whose component is set to None: its picker hides then. */
export function avatarColorShown(
  options: Readonly<Record<string, string | number>>,
  colorKey: string,
): boolean {
  const variantKey = COLOR_COMPONENT[colorKey];
  return (
    variantKey === undefined || avatarVariantSelection(options, variantKey) !== AVATAR_NONE_VALUE
  );
}

/** `shortFlat` -> `Short Flat`, `prescription01` -> `Prescription 01`: DiceBear value names as labels. */
export function humanizeAvatarValue(value: string): string {
  const spaced = value
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Avatar image uploads: JPEG, PNG or WebP (no SVG, no GIF), smaller than 1 MB.
 * Clients check a picked file before any request, the API checks the declared
 * size, the S3 POST policy enforces it and confirm checks the bytes.
 */
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AvatarMime = (typeof AVATAR_MIME_TYPES)[number];

/** Uploads must be smaller than 1 MB: 1,048,575 bytes at most. */
export const AVATAR_MAX_BYTES = 1024 * 1024 - 1;

/** Why a picked file cannot be uploaded, or null. Each client maps the reason to its message. */
export function avatarFileProblem(file: {
  size: number;
  type: string;
}): 'wrong_type' | 'too_large' | null {
  if (!(AVATAR_MIME_TYPES as readonly string[]).includes(file.type)) return 'wrong_type';
  if (file.size > AVATAR_MAX_BYTES) return 'too_large';
  return null;
}

/** The presigned POST an avatar upload-url route returns. */
export interface AvatarUploadTicket {
  uploadUrl: string;
  fields: Record<string, string>;
  s3Key: string;
  s3Bucket: string;
}

/**
 * Sends a picked file to storage with the presigned POST: the policy fields
 * first, unchanged, the file last (S3 enforces the key, the type and the
 * size). Throws when storage refuses the upload.
 */
export async function postAvatarUpload(
  ticket: AvatarUploadTicket,
  file: Blob,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const form = new FormData();
  for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
  form.append('file', file);
  const uploaded = await fetchImpl(ticket.uploadUrl, { method: 'POST', body: form });
  if (!uploaded.ok) throw new Error(`avatar upload failed with ${String(uploaded.status)}`);
}
