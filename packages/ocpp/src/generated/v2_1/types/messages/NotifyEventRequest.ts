import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { VariableType } from '../common/VariableType.js';

import type { EventNotificationEnum } from '../../enums/EventNotificationEnum.js';
import type { EventTriggerEnum } from '../../enums/EventTriggerEnum.js';

export interface EventDataType {
  eventId: number;
  timestamp: string;
  trigger: EventTriggerEnum;
  cause?: number;
  actualValue: string;
  techCode?: string;
  techInfo?: string;
  cleared?: boolean;
  transactionId?: string;
  component: ComponentType;
  variableMonitoringId?: number;
  eventNotificationType: EventNotificationEnum;
  variable: VariableType;
  severity?: number;
  customData?: CustomDataType;
}

export interface NotifyEventRequest {
  generatedAt: string;
  tbc?: boolean;
  seqNo: number;
  eventData: EventDataType[];
  customData?: CustomDataType;
}
