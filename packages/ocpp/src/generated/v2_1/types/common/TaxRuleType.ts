import type { CustomDataType } from './CustomDataType.js';
import type { RationalNumberType } from './RationalNumberType.js';

export interface TaxRuleType {
  taxRuleID: number;
  taxRuleName?: string;
  taxIncludedInPrice?: boolean;
  appliesToEnergyFee: boolean;
  appliesToParkingFee: boolean;
  appliesToOverstayFee: boolean;
  appliesToMinimumMaximumCost: boolean;
  taxRate: RationalNumberType;
  customData?: CustomDataType;
}
