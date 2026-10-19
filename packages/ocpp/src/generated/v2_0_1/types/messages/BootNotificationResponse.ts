import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { RegistrationStatusEnum } from '../../enums/RegistrationStatusEnum.js';

export interface BootNotificationResponse {
  customData?: CustomDataType;
  currentTime: string;
  interval: number;
  status: RegistrationStatusEnum;
  statusInfo?: StatusInfoType;
}
