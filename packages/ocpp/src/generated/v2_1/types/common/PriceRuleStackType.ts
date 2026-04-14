import type { CustomDataType } from './CustomDataType.js';
import type { PriceRuleType } from './PriceRuleType.js';

export interface PriceRuleStackType {
  duration: number;
  priceRule: PriceRuleType[];
  customData?: CustomDataType;
}
