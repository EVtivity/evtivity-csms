import type { CustomDataType } from './CustomDataType.js';
import type { IdTokenType } from './IdTokenType.js';
import type { MessageContentType } from './MessageContentType.js';

import type { AuthorizationStatusEnum } from '../../enums/AuthorizationStatusEnum.js';

export interface IdTokenInfoType {
  customData?: CustomDataType;
  status: AuthorizationStatusEnum;
  cacheExpiryDateTime?: string;
  chargingPriority?: number;
  language1?: string;
  evseId?: number[];
  groupIdToken?: IdTokenType;
  language2?: string;
  personalMessage?: MessageContentType;
}
