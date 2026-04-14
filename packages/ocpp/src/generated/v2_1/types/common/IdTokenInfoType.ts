import type { CustomDataType } from './CustomDataType.js';
import type { IdTokenType } from './IdTokenType.js';
import type { MessageContentType } from './MessageContentType.js';

import type { AuthorizationStatusEnum } from '../../enums/AuthorizationStatusEnum.js';

export interface IdTokenInfoType {
  status: AuthorizationStatusEnum;
  cacheExpiryDateTime?: string;
  chargingPriority?: number;
  groupIdToken?: IdTokenType;
  language1?: string;
  language2?: string;
  evseId?: number[];
  personalMessage?: MessageContentType;
  customData?: CustomDataType;
}
