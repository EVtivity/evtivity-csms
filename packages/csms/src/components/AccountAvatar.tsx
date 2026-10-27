// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** An avatar as the driver, fleet and user replies carry it. */
export type AvatarData =
  | {
      kind: 'generated';
      style: 'avataaars';
      seed: string;
      options: Record<string, string | number>;
    }
  | { kind: 'image'; url: string | null };

const SIZES = {
  sm: 'h-7 w-7 text-xs',
  lg: 'h-14 w-14 text-xl',
  md: 'h-9 w-9 text-sm',
} as const;

/** The SVG data URI of a generated avatar. DiceBear loads on demand, out of the first bundle. */
function useGeneratedAvatarUri(avatar: AvatarData | null | undefined): string | null {
  const [uri, setUri] = useState<string | null>(null);
  // One string holds everything the render reads, so the effect reruns only on a change.
  const key =
    avatar?.kind === 'generated'
      ? JSON.stringify({ seed: avatar.seed, options: avatar.options })
      : null;
  useEffect(() => {
    if (key == null) {
      setUri(null);
      return;
    }
    const { seed, options } = JSON.parse(key) as {
      seed: string;
      options: Record<string, string | number>;
    };
    let active = true;
    // Options off the allow-list render nothing: the avatar falls back to initials.
    void import('@evtivity/lib/account-avatar').then(({ checkedGeneratedAvatarDataUri }) => {
      if (active) setUri(checkedGeneratedAvatarDataUri({ style: 'avataaars', seed, options }));
    });
    return () => {
      active = false;
    };
  }, [key]);
  return uri;
}

function initials(firstName: string | null | undefined, lastName: string | null | undefined) {
  return [firstName, lastName]
    .map((part) => (part ?? '').trim().charAt(0))
    .join('')
    .toUpperCase();
}

interface AccountAvatarProps {
  avatar: AvatarData | null | undefined;
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}

/**
 * A driver or user avatar: the generated one, the uploaded image, or initials. It
 * renders only into an `<img src>`.
 */
export function AccountAvatar({
  avatar,
  firstName,
  lastName,
  size = 'sm',
  className,
}: AccountAvatarProps): React.JSX.Element {
  const { t } = useTranslation();
  const generatedUri = useGeneratedAvatarUri(avatar);
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = avatar?.kind === 'image' ? avatar.url : null;
  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);
  const name = `${firstName ?? ''} ${lastName ?? ''}`.trim();
  const src = generatedUri ?? (imageUrl != null && !imageFailed ? imageUrl : null);
  const base = cn(
    'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-semibold text-muted-foreground',
    SIZES[size],
    className,
  );
  if (src != null) {
    return (
      <img
        src={src}
        alt={t('avatar.alt', { name })}
        className={cn(base, 'object-cover')}
        onError={() => {
          setImageFailed(true);
        }}
      />
    );
  }
  return (
    <span className={base} role="img" aria-label={t('avatar.alt', { name })}>
      {initials(firstName, lastName)}
    </span>
  );
}
