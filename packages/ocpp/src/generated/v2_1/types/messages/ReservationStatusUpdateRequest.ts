import type { CustomDataType } from '../common/CustomDataType.js';

import type { ReservationUpdateStatusEnum } from '../../enums/ReservationUpdateStatusEnum.js';

export interface ReservationStatusUpdateRequest {
  reservationId: number;
  reservationUpdateStatus: ReservationUpdateStatusEnum;
  customData?: CustomDataType;
}
