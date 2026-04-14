import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { PeriodicEventStreamParamsType } from '../common/PeriodicEventStreamParamsType.js';
import type { VariableType } from '../common/VariableType.js';

import type { MonitorEnum } from '../../enums/MonitorEnum.js';

export interface SetMonitoringDataType {
  id?: number;
  periodicEventStream?: PeriodicEventStreamParamsType;
  transaction?: boolean;
  value: number;
  type: MonitorEnum;
  severity: number;
  component: ComponentType;
  variable: VariableType;
  customData?: CustomDataType;
}

export interface SetVariableMonitoringRequest {
  setMonitoringData: SetMonitoringDataType[];
  customData?: CustomDataType;
}
