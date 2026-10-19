import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenInfoType } from '../common/IdTokenInfoType.js';
import type { IdTokenType } from '../common/IdTokenType.js';

import type { UpdateEnum } from '../../enums/UpdateEnum.js';

export interface AuthorizationData {
  customData?: CustomDataType;
  idToken: IdTokenType;
  idTokenInfo?: IdTokenInfoType;
}

export interface SendLocalListRequest {
  customData?: CustomDataType;
  localAuthorizationList?: AuthorizationData[];
  versionNumber: number;
  updateType: UpdateEnum;
}
