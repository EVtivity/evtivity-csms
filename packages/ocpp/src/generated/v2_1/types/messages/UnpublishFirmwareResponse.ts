import type { CustomDataType } from '../common/CustomDataType.js';

import type { UnpublishFirmwareStatusEnum } from '../../enums/UnpublishFirmwareStatusEnum.js';

export interface UnpublishFirmwareResponse {
  status: UnpublishFirmwareStatusEnum;
  customData?: CustomDataType;
}
