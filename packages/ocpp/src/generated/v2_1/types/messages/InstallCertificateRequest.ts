import type { CustomDataType } from '../common/CustomDataType.js';

import type { InstallCertificateUseEnum } from '../../enums/InstallCertificateUseEnum.js';

export interface InstallCertificateRequest {
  certificateType: InstallCertificateUseEnum;
  certificate: string;
  customData?: CustomDataType;
}
