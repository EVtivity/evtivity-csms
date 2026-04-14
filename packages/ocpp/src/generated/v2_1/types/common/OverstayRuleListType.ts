import type { CustomDataType } from './CustomDataType.js';
import type { OverstayRuleType } from './OverstayRuleType.js';
import type { RationalNumberType } from './RationalNumberType.js';

export interface OverstayRuleListType {
  overstayPowerThreshold?: RationalNumberType;
  overstayRule: OverstayRuleType[];
  overstayTimeThreshold?: number;
  customData?: CustomDataType;
}
