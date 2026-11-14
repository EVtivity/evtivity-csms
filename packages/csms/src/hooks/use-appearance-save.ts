// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/error-message';

/**
 * Runs a theme or mode save of the auth store and says when it failed. The store
 * puts the previous choice back first, so the page never shows an unsaved theme.
 */
export function useAppearanceSave(): (save: Promise<void>) => void {
  const { t } = useTranslation();
  const { toast } = useToast();
  return (save) => {
    save.catch((err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    });
  };
}
