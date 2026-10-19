import type { CustomDataType } from '../common/CustomDataType.js';

export interface CancelReservationRequest {
  customData?: CustomDataType;
  reservationId: number;
}
