// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  chargingPointPath,
  type ChargingPointPathInput,
  type ChargingPointPathOptions,
} from '@evtivity/lib/charging-point-path';
import { useConnectorTypeLabel } from '@/hooks/use-connector-type-label';

/** A session's charging point as one line: Site / Station / Unit / EVSE / Connector type. */
export function useChargingPointPath(): (
  input: ChargingPointPathInput,
  options?: ChargingPointPathOptions,
) => string {
  const { t } = useTranslation();
  const connectorTypeLabel = useConnectorTypeLabel();
  return useCallback(
    (input: ChargingPointPathInput, options?: ChargingPointPathOptions) =>
      chargingPointPath(
        input,
        {
          evse: (id) => t('sessions.evseNumber', { id }),
          connector: (id) => t('sessions.connectorNumber', { id }),
          connectorType: connectorTypeLabel,
        },
        options,
      ),
    [t, connectorTypeLabel],
  );
}
