import type { CustomDataType } from '../common/CustomDataType.js';

import type { UnpublishFirmwareStatusEnum } from '../../enums/UnpublishFirmwareStatusEnum.js';

export interface UnpublishFirmwareResponse {
  customData?: CustomDataType;
  status: UnpublishFirmwareStatusEnum;
}
