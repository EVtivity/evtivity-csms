import type { CustomDataType } from '../common/CustomDataType.js';

export interface ClearTariffsRequest {
  tariffIds?: string[];
  evseId?: number;
  customData?: CustomDataType;
}
