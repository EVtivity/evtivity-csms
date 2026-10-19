import type { CustomDataType } from '../common/CustomDataType.js';

import type { CertificateActionEnum } from '../../enums/CertificateActionEnum.js';

export interface Get15118EVCertificateRequest {
  customData?: CustomDataType;
  iso15118SchemaVersion: string;
  action: CertificateActionEnum;
  exiRequest: string;
}
