import type { ChargingSchedulePeriodType } from '../common/ChargingSchedulePeriodType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ChargingRateUnitEnum } from '../../enums/ChargingRateUnitEnum.js';
import type { GenericStatusEnum } from '../../enums/GenericStatusEnum.js';

export interface CompositeScheduleType {
  customData?: CustomDataType;
  chargingSchedulePeriod: ChargingSchedulePeriodType[];
  evseId: number;
  duration: number;
  scheduleStart: string;
  chargingRateUnit: ChargingRateUnitEnum;
}

export interface GetCompositeScheduleResponse {
  customData?: CustomDataType;
  status: GenericStatusEnum;
  statusInfo?: StatusInfoType;
  schedule?: CompositeScheduleType;
}
