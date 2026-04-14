import type { CustomDataType } from './CustomDataType.js';

export interface ChargingScheduleUpdateType {
  limit?: number;
  limit_L2?: number;
  limit_L3?: number;
  dischargeLimit?: number;
  dischargeLimit_L2?: number;
  dischargeLimit_L3?: number;
  setpoint?: number;
  setpoint_L2?: number;
  setpoint_L3?: number;
  setpointReactive?: number;
  setpointReactive_L2?: number;
  setpointReactive_L3?: number;
  customData?: CustomDataType;
}
