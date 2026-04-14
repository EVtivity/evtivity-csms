import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';
import type { VariableType } from '../common/VariableType.js';

import type { MonitorEnum } from '../../enums/MonitorEnum.js';
import type { SetMonitoringStatusEnum } from '../../enums/SetMonitoringStatusEnum.js';

export interface SetMonitoringResultType {
  id?: number;
  statusInfo?: StatusInfoType;
  status: SetMonitoringStatusEnum;
  type: MonitorEnum;
  component: ComponentType;
  variable: VariableType;
  severity: number;
  customData?: CustomDataType;
}

export interface SetVariableMonitoringResponse {
  setMonitoringResult: SetMonitoringResultType[];
  customData?: CustomDataType;
}
