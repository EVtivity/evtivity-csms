import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenInfoType } from '../common/IdTokenInfoType.js';

import type { AuthorizeCertificateStatusEnum } from '../../enums/AuthorizeCertificateStatusEnum.js';

export interface AuthorizeResponse {
  customData?: CustomDataType;
  idTokenInfo: IdTokenInfoType;
  certificateStatus?: AuthorizeCertificateStatusEnum;
}
