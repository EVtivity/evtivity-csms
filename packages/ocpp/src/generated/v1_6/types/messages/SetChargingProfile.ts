import type { ChargingScheduleType } from '../common/ChargingScheduleType.js';

import type { SetChargingProfileChargingProfileKindEnum } from '../../enums/SetChargingProfileChargingProfileKindEnum.js';
import type { SetChargingProfileChargingProfilePurposeEnum } from '../../enums/SetChargingProfileChargingProfilePurposeEnum.js';
import type { SetChargingProfileRecurrencyKindEnum } from '../../enums/SetChargingProfileRecurrencyKindEnum.js';

export interface CsChargingProfilesType {
  chargingProfileId: number;
  transactionId?: number;
  stackLevel: number;
  chargingProfilePurpose: SetChargingProfileChargingProfilePurposeEnum;
  chargingProfileKind: SetChargingProfileChargingProfileKindEnum;
  recurrencyKind?: SetChargingProfileRecurrencyKindEnum;
  validFrom?: string;
  validTo?: string;
  chargingSchedule: ChargingScheduleType;
}

export interface SetChargingProfile {
  connectorId: number;
  csChargingProfiles: CsChargingProfilesType;
}
