import type { CustomDataType } from './CustomDataType.js';
import type { RationalNumberType } from './RationalNumberType.js';

export interface PriceRuleType {
  parkingFeePeriod?: number;
  carbonDioxideEmission?: number;
  renewableGenerationPercentage?: number;
  energyFee: RationalNumberType;
  parkingFee?: RationalNumberType;
  powerRangeStart: RationalNumberType;
  customData?: CustomDataType;
}
