import type { ChargingSchedulePeriodType } from '../common/ChargingSchedulePeriodType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ChargingRateUnitEnum } from '../../enums/ChargingRateUnitEnum.js';
import type { GenericStatusEnum } from '../../enums/GenericStatusEnum.js';

export interface CompositeScheduleType {
  evseId: number;
  duration: number;
  scheduleStart: string;
  chargingRateUnit: ChargingRateUnitEnum;
  chargingSchedulePeriod: ChargingSchedulePeriodType[];
  customData?: CustomDataType;
}

export interface GetCompositeScheduleResponse {
  status: GenericStatusEnum;
  statusInfo?: StatusInfoType;
  schedule?: CompositeScheduleType;
  customData?: CustomDataType;
}
