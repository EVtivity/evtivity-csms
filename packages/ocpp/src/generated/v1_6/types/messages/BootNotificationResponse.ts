import type { BootNotificationStatusEnum } from '../../enums/BootNotificationStatusEnum.js';

export interface BootNotificationResponse {
  status: BootNotificationStatusEnum;
  currentTime: string;
  interval: number;
}
