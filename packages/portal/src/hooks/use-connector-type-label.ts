// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { connectorTypeLabel } from '@evtivity/lib/connector-type-label';

/** The connector type name drivers see ("J1772", "Type 2", "Other"), in the UI language. Display only. */
export function useConnectorTypeLabel(): (type: string | null | undefined) => string {
  const { t } = useTranslation();
  return useCallback(
    (type: string | null | undefined) =>
      connectorTypeLabel(type, {
        other: t('connectorTypeNames.other'),
        pantograph: t('connectorTypeNames.pantograph'),
      }),
    [t],
  );
}
