import type { CustomDataType } from '../common/CustomDataType.js';

import type { GetCertificateIdUseEnum } from '../../enums/GetCertificateIdUseEnum.js';

export interface GetInstalledCertificateIdsRequest {
  customData?: CustomDataType;
  certificateType?: GetCertificateIdUseEnum[];
}
