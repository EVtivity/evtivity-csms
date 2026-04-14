import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { VariableType } from '../common/VariableType.js';

import type { EventNotificationEnum } from '../../enums/EventNotificationEnum.js';
import type { MonitorEnum } from '../../enums/MonitorEnum.js';

export interface MonitoringDataType {
  component: ComponentType;
  variable: VariableType;
  variableMonitoring: VariableMonitoringType[];
  customData?: CustomDataType;
}

export interface VariableMonitoringType {
  id: number;
  transaction: boolean;
  value: number;
  type: MonitorEnum;
  severity: number;
  eventNotificationType: EventNotificationEnum;
  customData?: CustomDataType;
}

export interface NotifyMonitoringReportRequest {
  monitor?: MonitoringDataType[];
  requestId: number;
  tbc?: boolean;
  seqNo: number;
  generatedAt: string;
  customData?: CustomDataType;
}
