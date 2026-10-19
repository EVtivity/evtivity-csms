import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { UnlockStatusEnum } from '../../enums/UnlockStatusEnum.js';

export interface UnlockConnectorResponse {
  customData?: CustomDataType;
  status: UnlockStatusEnum;
  statusInfo?: StatusInfoType;
}
