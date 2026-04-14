import type { CertificateHashDataType } from '../common/CertificateHashDataType.js';

import type { GetInstalledCertificateIdsStatusEnum } from '../../enums/GetInstalledCertificateIdsStatusEnum.js';

export interface GetInstalledCertificateIdsResponse {
  status: GetInstalledCertificateIdsStatusEnum;
  certificateHashData?: CertificateHashDataType[];
}
