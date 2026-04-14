import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ClearMonitoringStatusEnum } from '../../enums/ClearMonitoringStatusEnum.js';

export interface ClearMonitoringResultType {
  status: ClearMonitoringStatusEnum;
  id: number;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}

export interface ClearVariableMonitoringResponse {
  clearMonitoringResult: ClearMonitoringResultType[];
  customData?: CustomDataType;
}
