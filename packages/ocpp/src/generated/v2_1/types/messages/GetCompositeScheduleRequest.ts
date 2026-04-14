import type { CustomDataType } from '../common/CustomDataType.js';

import type { ChargingRateUnitEnum } from '../../enums/ChargingRateUnitEnum.js';

export interface GetCompositeScheduleRequest {
  duration: number;
  chargingRateUnit?: ChargingRateUnitEnum;
  evseId: number;
  customData?: CustomDataType;
}
