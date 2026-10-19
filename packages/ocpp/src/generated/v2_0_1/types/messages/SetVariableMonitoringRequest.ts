import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { VariableType } from '../common/VariableType.js';

import type { MonitorEnum } from '../../enums/MonitorEnum.js';

export interface SetMonitoringDataType {
  customData?: CustomDataType;
  id?: number;
  transaction?: boolean;
  value: number;
  type: MonitorEnum;
  severity: number;
  component: ComponentType;
  variable: VariableType;
}

export interface SetVariableMonitoringRequest {
  customData?: CustomDataType;
  setMonitoringData: SetMonitoringDataType[];
}
