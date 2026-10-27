// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { initialsOf, type DriverAvatar as Avatar } from '@/lib/avatar';

const SIZES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-20 w-20 text-2xl',
} as const;

/**
 * The SVG data URI of a generated avatar. DiceBear loads on demand, so it
 * stays out of the first bundle. Rendered only into an `<img src>`.
 */
export function useGeneratedAvatarUri(avatar: Avatar | null | undefined): string | null {
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

interface DriverAvatarProps {
  avatar: Avatar | null | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}

/** A driver's avatar: the generated one, the uploaded image, or initials. */
export function DriverAvatar({
  avatar,
  firstName,
  lastName,
  size = 'md',
  className,
}: DriverAvatarProps): React.JSX.Element {
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
        alt={t('account.avatarAlt', { name })}
        className={cn(base, 'object-cover')}
        onError={() => {
          setImageFailed(true);
        }}
      />
    );
  }
  return (
    <span className={base} role="img" aria-label={t('account.avatarAlt', { name })}>
      {initialsOf(firstName, lastName)}
    </span>
  );
}
