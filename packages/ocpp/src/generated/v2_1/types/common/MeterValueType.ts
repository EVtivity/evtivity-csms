import type { CustomDataType } from './CustomDataType.js';
import type { SampledValueType } from './SampledValueType.js';

export interface MeterValueType {
  sampledValue: SampledValueType[];
  timestamp: string;
  customData?: CustomDataType;
}
