import type { AdditionalInfoType } from './AdditionalInfoType.js';
import type { CustomDataType } from './CustomDataType.js';

import type { IdTokenEnum } from '../../enums/IdTokenEnum.js';

export interface IdTokenType {
  customData?: CustomDataType;
  additionalInfo?: AdditionalInfoType[];
  idToken: string;
  type: IdTokenEnum;
}
