import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ClearMessageStatusEnum } from '../../enums/ClearMessageStatusEnum.js';

export interface ClearDisplayMessageResponse {
  customData?: CustomDataType;
  status: ClearMessageStatusEnum;
  statusInfo?: StatusInfoType;
}
