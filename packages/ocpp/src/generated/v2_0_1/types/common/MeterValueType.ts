import type { CustomDataType } from './CustomDataType.js';
import type { SampledValueType } from './SampledValueType.js';

export interface MeterValueType {
  customData?: CustomDataType;
  sampledValue: SampledValueType[];
  timestamp: string;
}
