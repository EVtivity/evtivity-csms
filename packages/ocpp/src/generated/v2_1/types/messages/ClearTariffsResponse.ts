import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { TariffClearStatusEnum } from '../../enums/TariffClearStatusEnum.js';

export interface ClearTariffsResultType {
  statusInfo?: StatusInfoType;
  tariffId?: string;
  status: TariffClearStatusEnum;
  customData?: CustomDataType;
}

export interface ClearTariffsResponse {
  clearTariffsResult: ClearTariffsResultType[];
  customData?: CustomDataType;
}
