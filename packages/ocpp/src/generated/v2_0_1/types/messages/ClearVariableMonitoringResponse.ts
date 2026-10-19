import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ClearMonitoringStatusEnum } from '../../enums/ClearMonitoringStatusEnum.js';

export interface ClearMonitoringResultType {
  customData?: CustomDataType;
  status: ClearMonitoringStatusEnum;
  id: number;
  statusInfo?: StatusInfoType;
}

export interface ClearVariableMonitoringResponse {
  customData?: CustomDataType;
  clearMonitoringResult: ClearMonitoringResultType[];
}
