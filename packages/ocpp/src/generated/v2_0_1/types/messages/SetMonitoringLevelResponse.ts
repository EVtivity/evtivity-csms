import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { GenericStatusEnum } from '../../enums/GenericStatusEnum.js';

export interface SetMonitoringLevelResponse {
  customData?: CustomDataType;
  status: GenericStatusEnum;
  statusInfo?: StatusInfoType;
}
