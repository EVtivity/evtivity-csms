import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { VariableType } from '../common/VariableType.js';

import type { MonitorEnum } from '../../enums/MonitorEnum.js';

export interface MonitoringDataType {
  customData?: CustomDataType;
  component: ComponentType;
  variable: VariableType;
  variableMonitoring: VariableMonitoringType[];
}

export interface VariableMonitoringType {
  customData?: CustomDataType;
  id: number;
  transaction: boolean;
  value: number;
  type: MonitorEnum;
  severity: number;
}

export interface NotifyMonitoringReportRequest {
  customData?: CustomDataType;
  monitor?: MonitoringDataType[];
  requestId: number;
  tbc?: boolean;
  seqNo: number;
  generatedAt: string;
}
