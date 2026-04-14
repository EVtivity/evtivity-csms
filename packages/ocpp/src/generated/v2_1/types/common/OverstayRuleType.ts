import type { CustomDataType } from './CustomDataType.js';
import type { RationalNumberType } from './RationalNumberType.js';

export interface OverstayRuleType {
  overstayFee: RationalNumberType;
  overstayRuleDescription?: string;
  startTime: number;
  overstayFeePeriod: number;
  customData?: CustomDataType;
}
