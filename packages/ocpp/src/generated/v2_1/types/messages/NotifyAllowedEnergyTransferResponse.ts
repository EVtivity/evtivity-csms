import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { NotifyAllowedEnergyTransferStatusEnum } from '../../enums/NotifyAllowedEnergyTransferStatusEnum.js';

export interface NotifyAllowedEnergyTransferResponse {
  status: NotifyAllowedEnergyTransferStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
