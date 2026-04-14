import type { CustomDataType } from './CustomDataType.js';

export interface AdditionalInfoType {
  additionalIdToken: string;
  type: string;
  customData?: CustomDataType;
}
