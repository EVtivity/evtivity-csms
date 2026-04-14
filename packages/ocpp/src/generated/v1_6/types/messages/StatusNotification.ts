import type { StatusNotificationErrorCodeEnum } from '../../enums/StatusNotificationErrorCodeEnum.js';
import type { StatusNotificationStatusEnum } from '../../enums/StatusNotificationStatusEnum.js';

export interface StatusNotification {
  connectorId: number;
  errorCode: StatusNotificationErrorCodeEnum;
  info?: string;
  status: StatusNotificationStatusEnum;
  timestamp?: string;
  vendorId?: string;
  vendorErrorCode?: string;
}
