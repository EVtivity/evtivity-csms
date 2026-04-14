import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { TariffGetStatusEnum } from '../../enums/TariffGetStatusEnum.js';
import type { TariffKindEnum } from '../../enums/TariffKindEnum.js';

export interface TariffAssignmentType {
  tariffId: string;
  tariffKind: TariffKindEnum;
  validFrom?: string;
  evseIds?: number[];
  idTokens?: string[];
  customData?: CustomDataType;
}

export interface GetTariffsResponse {
  status: TariffGetStatusEnum;
  statusInfo?: StatusInfoType;
  tariffAssignments?: TariffAssignmentType[];
  customData?: CustomDataType;
}
