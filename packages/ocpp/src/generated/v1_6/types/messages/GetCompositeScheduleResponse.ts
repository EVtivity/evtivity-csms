import type { ChargingScheduleType } from '../common/ChargingScheduleType.js';

import type { GetCompositeScheduleStatusEnum } from '../../enums/GetCompositeScheduleStatusEnum.js';

export interface GetCompositeScheduleResponse {
  status: GetCompositeScheduleStatusEnum;
  connectorId?: number;
  scheduleStart?: string;
  chargingSchedule?: ChargingScheduleType;
}
