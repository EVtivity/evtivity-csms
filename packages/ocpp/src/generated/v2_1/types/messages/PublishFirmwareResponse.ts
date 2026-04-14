import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { GenericStatusEnum } from '../../enums/GenericStatusEnum.js';

export interface PublishFirmwareResponse {
  status: GenericStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
