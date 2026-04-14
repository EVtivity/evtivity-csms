import type { CustomDataType } from './CustomDataType.js';
import type { V2XFreqWattPointType } from './V2XFreqWattPointType.js';
import type { V2XSignalWattPointType } from './V2XSignalWattPointType.js';

import type { OperationModeEnum } from '../../enums/OperationModeEnum.js';

export interface ChargingSchedulePeriodType {
  startPeriod: number;
  limit?: number;
  limit_L2?: number;
  limit_L3?: number;
  numberPhases?: number;
  phaseToUse?: number;
  dischargeLimit?: number;
  dischargeLimit_L2?: number;
  dischargeLimit_L3?: number;
  setpoint?: number;
  setpoint_L2?: number;
  setpoint_L3?: number;
  setpointReactive?: number;
  setpointReactive_L2?: number;
  setpointReactive_L3?: number;
  preconditioningRequest?: boolean;
  evseSleep?: boolean;
  v2xBaseline?: number;
  operationMode?: OperationModeEnum;
  v2xFreqWattCurve?: V2XFreqWattPointType[];
  v2xSignalWattCurve?: V2XSignalWattPointType[];
  customData?: CustomDataType;
}
