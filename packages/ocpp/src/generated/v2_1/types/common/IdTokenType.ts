import type { AdditionalInfoType } from './AdditionalInfoType.js';
import type { CustomDataType } from './CustomDataType.js';

export interface IdTokenType {
  additionalInfo?: AdditionalInfoType[];
  idToken: string;
  type: string;
  customData?: CustomDataType;
}
