// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';

interface LoadingLogoProps {
  /** 'page' centers in the content area; 'inline' fits cards and table cells. */
  size?: 'page' | 'inline';
}

// Loading state: the animated brand mark, centered. Replaces translatable
// loading text everywhere (pages, cards, table bodies).
export function LoadingLogo({ size = 'page' }: LoadingLogoProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t('common.loading')}
      className={
        size === 'page'
          ? 'flex min-h-[50vh] items-center justify-center'
          : 'flex items-center justify-center py-8'
      }
    >
      <img
        src="/evtivity-logo-animated.svg"
        alt=""
        className={size === 'page' ? 'h-16 w-16' : 'h-10 w-10'}
      />
    </div>
  );
}
