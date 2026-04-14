import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { DisplayMessageStatusEnum } from '../../enums/DisplayMessageStatusEnum.js';

export interface SetDisplayMessageResponse {
  status: DisplayMessageStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
