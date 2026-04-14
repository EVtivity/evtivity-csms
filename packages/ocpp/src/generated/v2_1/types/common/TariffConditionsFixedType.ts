import type { CustomDataType } from './CustomDataType.js';

import type { DayOfWeekEnum } from '../../enums/DayOfWeekEnum.js';
import type { EvseKindEnum } from '../../enums/EvseKindEnum.js';

export interface TariffConditionsFixedType {
  startTimeOfDay?: string;
  endTimeOfDay?: string;
  dayOfWeek?: DayOfWeekEnum[];
  validFromDate?: string;
  validToDate?: string;
  evseKind?: EvseKindEnum;
  paymentBrand?: string;
  paymentRecognition?: string;
  customData?: CustomDataType;
}
