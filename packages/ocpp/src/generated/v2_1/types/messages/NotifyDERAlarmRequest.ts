import type { CustomDataType } from '../common/CustomDataType.js';

import type { DERControlEnum } from '../../enums/DERControlEnum.js';
import type { GridEventFaultEnum } from '../../enums/GridEventFaultEnum.js';

export interface NotifyDERAlarmRequest {
  controlType: DERControlEnum;
  gridEventFault?: GridEventFaultEnum;
  alarmEnded?: boolean;
  timestamp: string;
  extraInfo?: string;
  customData?: CustomDataType;
}
