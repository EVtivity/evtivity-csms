import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { TariffSetStatusEnum } from '../../enums/TariffSetStatusEnum.js';

export interface SetDefaultTariffResponse {
  status: TariffSetStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
