import type { CustomDataType } from '../common/CustomDataType.js';

import type { ChargingLimitSourceEnum } from '../../enums/ChargingLimitSourceEnum.js';

export interface ClearedChargingLimitRequest {
  customData?: CustomDataType;
  chargingLimitSource: ChargingLimitSourceEnum;
  evseId?: number;
}
