import type { CustomDataType } from '../common/CustomDataType.js';

export interface VatNumberValidationRequest {
  vatNumber: string;
  evseId?: number;
  customData?: CustomDataType;
}
