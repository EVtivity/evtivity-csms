import type { CustomDataType } from './CustomDataType.js';
import type { SalesTariffEntryType } from './SalesTariffEntryType.js';

export interface SalesTariffType {
  customData?: CustomDataType;
  id: number;
  salesTariffDescription?: string;
  numEPriceLevels?: number;
  salesTariffEntry: SalesTariffEntryType[];
}
