import type { CustomDataType } from '../common/CustomDataType.js';
import type { MeterValueType } from '../common/MeterValueType.js';

export interface MeterValuesRequest {
  evseId: number;
  meterValue: MeterValueType[];
  customData?: CustomDataType;
}
