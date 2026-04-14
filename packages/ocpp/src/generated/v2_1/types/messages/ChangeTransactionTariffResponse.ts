import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { TariffChangeStatusEnum } from '../../enums/TariffChangeStatusEnum.js';

export interface ChangeTransactionTariffResponse {
  status: TariffChangeStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
