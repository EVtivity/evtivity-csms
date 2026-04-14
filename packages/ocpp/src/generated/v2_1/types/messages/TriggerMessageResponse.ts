import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { TriggerMessageStatusEnum } from '../../enums/TriggerMessageStatusEnum.js';

export interface TriggerMessageResponse {
  status: TriggerMessageStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
