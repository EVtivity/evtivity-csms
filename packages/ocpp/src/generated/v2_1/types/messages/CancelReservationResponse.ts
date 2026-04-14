import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { CancelReservationStatusEnum } from '../../enums/CancelReservationStatusEnum.js';

export interface CancelReservationResponse {
  status: CancelReservationStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
