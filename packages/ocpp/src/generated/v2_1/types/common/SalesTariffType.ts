import type { CustomDataType } from './CustomDataType.js';
import type { SalesTariffEntryType } from './SalesTariffEntryType.js';

export interface SalesTariffType {
  id: number;
  salesTariffDescription?: string;
  numEPriceLevels?: number;
  salesTariffEntry: SalesTariffEntryType[];
  customData?: CustomDataType;
}
