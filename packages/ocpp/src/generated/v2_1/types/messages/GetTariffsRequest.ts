import type { CustomDataType } from '../common/CustomDataType.js';

export interface GetTariffsRequest {
  evseId: number;
  customData?: CustomDataType;
}
