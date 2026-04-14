import type { CustomDataType } from '../common/CustomDataType.js';

export interface CancelReservationRequest {
  reservationId: number;
  customData?: CustomDataType;
}
