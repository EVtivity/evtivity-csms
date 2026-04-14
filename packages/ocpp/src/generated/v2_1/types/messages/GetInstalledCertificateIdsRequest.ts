import type { CustomDataType } from '../common/CustomDataType.js';

import type { GetCertificateIdUseEnum } from '../../enums/GetCertificateIdUseEnum.js';

export interface GetInstalledCertificateIdsRequest {
  certificateType?: GetCertificateIdUseEnum[];
  customData?: CustomDataType;
}
