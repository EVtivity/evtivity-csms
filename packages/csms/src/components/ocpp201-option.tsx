// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';

interface Ocpp201OptionProps {
  value: string;
  /** The value exists in OCPP 2.1 only and the station uses OCPP 2.0.1. */
  unavailable: boolean;
}

/** A select option that an OCPP 2.0.1 station cannot take is shown disabled, with the reason. */
export function Ocpp201Option({ value, unavailable }: Ocpp201OptionProps): React.JSX.Element {
  const { t } = useTranslation();
  if (!unavailable) return <option value={value}>{value}</option>;
  const reason = t('stations.notAvailableOcpp201');
  return (
    <option value={value} disabled title={reason}>
      {`${value} (${reason})`}
    </option>
  );
}
