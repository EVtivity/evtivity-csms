import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { ClearCacheStatusEnum } from '../../enums/ClearCacheStatusEnum.js';

export interface ClearCacheResponse {
  status: ClearCacheStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
