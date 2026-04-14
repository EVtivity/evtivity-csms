import type { AdditionalSelectedServicesType } from './AdditionalSelectedServicesType.js';
import type { CustomDataType } from './CustomDataType.js';
import type { OverstayRuleListType } from './OverstayRuleListType.js';
import type { PriceRuleStackType } from './PriceRuleStackType.js';
import type { RationalNumberType } from './RationalNumberType.js';
import type { TaxRuleType } from './TaxRuleType.js';

export interface AbsolutePriceScheduleType {
  timeAnchor: string;
  priceScheduleID: number;
  priceScheduleDescription?: string;
  currency: string;
  language: string;
  priceAlgorithm: string;
  minimumCost?: RationalNumberType;
  maximumCost?: RationalNumberType;
  priceRuleStacks: PriceRuleStackType[];
  taxRules?: TaxRuleType[];
  overstayRuleList?: OverstayRuleListType;
  additionalSelectedServices?: AdditionalSelectedServicesType[];
  customData?: CustomDataType;
}
