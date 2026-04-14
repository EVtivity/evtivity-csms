import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenInfoType } from '../common/IdTokenInfoType.js';
import type { IdTokenType } from '../common/IdTokenType.js';

import type { UpdateEnum } from '../../enums/UpdateEnum.js';

export interface AuthorizationData {
  idToken: IdTokenType;
  idTokenInfo?: IdTokenInfoType;
  customData?: CustomDataType;
}

export interface SendLocalListRequest {
  localAuthorizationList?: AuthorizationData[];
  versionNumber: number;
  updateType: UpdateEnum;
  customData?: CustomDataType;
}
