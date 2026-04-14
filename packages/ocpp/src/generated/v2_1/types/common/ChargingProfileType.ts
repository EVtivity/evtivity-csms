import type { ChargingScheduleType } from './ChargingScheduleType.js';
import type { CustomDataType } from './CustomDataType.js';

import type { ChargingProfileKindEnum } from '../../enums/ChargingProfileKindEnum.js';
import type { ChargingProfilePurposeEnum } from '../../enums/ChargingProfilePurposeEnum.js';
import type { RecurrencyKindEnum } from '../../enums/RecurrencyKindEnum.js';

export interface ChargingProfileType {
  id: number;
  stackLevel: number;
  chargingProfilePurpose: ChargingProfilePurposeEnum;
  chargingProfileKind: ChargingProfileKindEnum;
  recurrencyKind?: RecurrencyKindEnum;
  validFrom?: string;
  validTo?: string;
  transactionId?: string;
  maxOfflineDuration?: number;
  chargingSchedule: ChargingScheduleType[];
  invalidAfterOfflineDuration?: boolean;
  dynUpdateInterval?: number;
  dynUpdateTime?: string;
  priceScheduleSignature?: string;
  customData?: CustomDataType;
}
