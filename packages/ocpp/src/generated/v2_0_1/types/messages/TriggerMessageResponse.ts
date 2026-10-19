import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { TriggerMessageStatusEnum } from '../../enums/TriggerMessageStatusEnum.js';

export interface TriggerMessageResponse {
  customData?: CustomDataType;
  status: TriggerMessageStatusEnum;
  statusInfo?: StatusInfoType;
}
