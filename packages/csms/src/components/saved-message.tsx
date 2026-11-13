// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/toast';

/**
 * The one success message of a save that keeps its form on screen, shown next
 * to the Save button once the save succeeded and nothing changed since
 * ("Saved successfully", `common.saved`). Pass children only for a message that
 * says more than that (for example "Storage settings saved."). A save that
 * closes its form (a dialog, an edit mode, a navigation) raises a success toast
 * with the same text instead.
 */
export function SavedMessage({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <p role="status" className="text-sm text-success" data-testid="saved-message">
      {children ?? t('common.saved')}
    </p>
  );
}

/**
 * The success toast of a create page, raised as the new record opens
 * ("Created successfully", `common.createdSuccessfully`).
 */
export function useCreatedToast(): () => void {
  const { t } = useTranslation();
  const { toast } = useToast();
  return () => {
    toast({ variant: 'success', title: t('common.createdSuccessfully') });
  };
}

/**
 * The success toast of a save that closes its form (a dialog, an edit mode or
 * a navigation), with the same "Saved successfully" text as `SavedMessage`.
 */
export function useSavedToast(): () => void {
  const { t } = useTranslation();
  const { toast } = useToast();
  return () => {
    toast({ variant: 'success', title: t('common.saved') });
  };
}
