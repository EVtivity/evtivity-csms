import type { CustomDataType } from '../common/CustomDataType.js';
import type { TariffType } from '../common/TariffType.js';

export interface SetDefaultTariffRequest {
  evseId: number;
  tariff: TariffType;
  customData?: CustomDataType;
}
