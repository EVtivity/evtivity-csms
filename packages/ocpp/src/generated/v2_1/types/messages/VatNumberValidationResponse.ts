import type { AddressType } from '../common/AddressType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { GenericStatusEnum } from '../../enums/GenericStatusEnum.js';

export interface VatNumberValidationResponse {
  company?: AddressType;
  statusInfo?: StatusInfoType;
  vatNumber: string;
  evseId?: number;
  status: GenericStatusEnum;
  customData?: CustomDataType;
}
