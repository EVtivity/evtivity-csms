import type { ChangeAvailabilityTypeEnum } from '../../enums/ChangeAvailabilityTypeEnum.js';

export interface ChangeAvailability {
  connectorId: number;
  type: ChangeAvailabilityTypeEnum;
}
