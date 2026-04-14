import type { SignedFirmwareStatusNotificationStatusEnum } from '../../enums/SignedFirmwareStatusNotificationStatusEnum.js';

export interface SignedFirmwareStatusNotification {
  status: SignedFirmwareStatusNotificationStatusEnum;
  requestId?: number;
}
