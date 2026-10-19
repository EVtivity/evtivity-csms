import type { CustomDataType } from '../common/CustomDataType.js';

import type { ChargingRateUnitEnum } from '../../enums/ChargingRateUnitEnum.js';

export interface GetCompositeScheduleRequest {
  customData?: CustomDataType;
  duration: number;
  chargingRateUnit?: ChargingRateUnitEnum;
  evseId: number;
}
