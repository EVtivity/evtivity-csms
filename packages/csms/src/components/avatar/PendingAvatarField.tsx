// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo } from 'react';
import { pendingAvatarPreview, type AvatarChoice } from '@/lib/avatar';
import { AvatarField } from './AvatarField';

export interface PendingAvatarFieldProps {
  /** The choice held until the account exists; null for no avatar. */
  choice: AvatarChoice | null;
  onChange: (choice: AvatarChoice | null) => void;
  firstName: string;
  lastName: string;
  description: string;
  hint: string;
}

/**
 * The avatar field of a New page (New Driver, New User): the editor stores
 * nothing, it keeps the choice, and the page applies it with
 * `applyAvatarChoice` right after the account is created. A picked photo
 * previews from its object URL.
 */
export function PendingAvatarField({
  choice,
  onChange,
  firstName,
  lastName,
  description,
  hint,
}: PendingAvatarFieldProps): React.JSX.Element {
  const file = choice?.kind === 'image' ? choice.file : null;
  const imageUrl = useMemo(() => (file == null ? null : URL.createObjectURL(file)), [file]);
  useEffect(() => {
    if (imageUrl == null) return;
    return () => {
      URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);
  return (
    <AvatarField
      avatar={pendingAvatarPreview(choice, imageUrl)}
      firstName={firstName}
      lastName={lastName}
      description={description}
      hint={hint}
      onSave={(next) => {
        onChange(next.kind === 'remove' ? null : next);
        return Promise.resolve();
      }}
    />
  );
}
