// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EditButton } from '@/components/edit-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AccountAvatar, type AvatarData } from '@/components/AccountAvatar';
import type { AvatarChoice } from '@/lib/avatar';
import { AvatarEditor } from './AvatarEditor';

export interface AvatarFieldProps {
  avatar: AvatarData | null | undefined;
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  /** Stores the choice; without it the field is read-only. */
  onSave?: (choice: AvatarChoice) => Promise<void>;
  /** The editor dialog text; the own-avatar text by default. */
  description?: string;
  /** A line under the avatar, such as when a New page stores it. */
  hint?: string;
}

/**
 * The avatar field of the Profile page and of the user and driver edit forms
 * and New pages: the avatar and Edit Avatar, which opens the avatar editor in
 * a dialog. Read-only without `onSave`.
 */
export function AvatarField({
  avatar,
  firstName,
  lastName,
  onSave,
  description,
  hint,
}: AvatarFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2" data-testid="avatar-field">
      <p className="text-sm font-medium">{t('avatar.label')}</p>
      <div className="flex flex-wrap items-center gap-4">
        <AccountAvatar avatar={avatar} firstName={firstName} lastName={lastName} size="lg" />
        {onSave != null && (
          <EditButton
            label={t('avatar.edit')}
            onClick={() => {
              setOpen(true);
            }}
          />
        )}
      </div>
      {hint != null && <p className="text-sm text-muted-foreground">{hint}</p>}
      {onSave != null && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t('avatar.edit')}</DialogTitle>
              <DialogDescription>{description ?? t('avatar.editDescription')}</DialogDescription>
            </DialogHeader>
            {open && (
              <AvatarEditor
                avatar={avatar}
                firstName={firstName}
                lastName={lastName}
                onSave={onSave}
                onDone={() => {
                  setOpen(false);
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
