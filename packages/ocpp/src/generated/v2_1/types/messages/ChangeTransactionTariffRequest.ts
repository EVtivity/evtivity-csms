import type { CustomDataType } from '../common/CustomDataType.js';
import type { TariffType } from '../common/TariffType.js';

export interface ChangeTransactionTariffRequest {
  tariff: TariffType;
  transactionId: string;
  customData?: CustomDataType;
}
