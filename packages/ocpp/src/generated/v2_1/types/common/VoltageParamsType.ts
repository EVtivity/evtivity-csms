import type { CustomDataType } from './CustomDataType.js';

import type { PowerDuringCessationEnum } from '../../enums/PowerDuringCessationEnum.js';

export interface VoltageParamsType {
  hv10MinMeanValue?: number;
  hv10MinMeanTripDelay?: number;
  powerDuringCessation?: PowerDuringCessationEnum;
  customData?: CustomDataType;
}
