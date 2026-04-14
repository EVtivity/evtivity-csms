import type { ChargingScheduleType } from '../common/ChargingScheduleType.js';

import type { RemoteStartTransactionChargingProfileKindEnum } from '../../enums/RemoteStartTransactionChargingProfileKindEnum.js';
import type { RemoteStartTransactionChargingProfilePurposeEnum } from '../../enums/RemoteStartTransactionChargingProfilePurposeEnum.js';
import type { RemoteStartTransactionRecurrencyKindEnum } from '../../enums/RemoteStartTransactionRecurrencyKindEnum.js';

export interface ChargingProfileType {
  chargingProfileId: number;
  transactionId?: number;
  stackLevel: number;
  chargingProfilePurpose: RemoteStartTransactionChargingProfilePurposeEnum;
  chargingProfileKind: RemoteStartTransactionChargingProfileKindEnum;
  recurrencyKind?: RemoteStartTransactionRecurrencyKindEnum;
  validFrom?: string;
  validTo?: string;
  chargingSchedule: ChargingScheduleType;
}

export interface RemoteStartTransaction {
  connectorId?: number;
  idTag: string;
  chargingProfile?: ChargingProfileType;
}
