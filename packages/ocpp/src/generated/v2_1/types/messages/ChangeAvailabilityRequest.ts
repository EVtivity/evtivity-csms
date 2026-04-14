import type { CustomDataType } from '../common/CustomDataType.js';
import type { EVSEType } from '../common/EVSEType.js';

import type { OperationalStatusEnum } from '../../enums/OperationalStatusEnum.js';

export interface ChangeAvailabilityRequest {
  evse?: EVSEType;
  operationalStatus: OperationalStatusEnum;
  customData?: CustomDataType;
}
