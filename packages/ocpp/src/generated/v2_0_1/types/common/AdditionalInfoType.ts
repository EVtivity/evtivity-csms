import type { CustomDataType } from './CustomDataType.js';

export interface AdditionalInfoType {
  customData?: CustomDataType;
  additionalIdToken: string;
  type: string;
}
