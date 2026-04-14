import type { LogStatusNotificationStatusEnum } from '../../enums/LogStatusNotificationStatusEnum.js';

export interface LogStatusNotification {
  status: LogStatusNotificationStatusEnum;
  requestId?: number;
}
