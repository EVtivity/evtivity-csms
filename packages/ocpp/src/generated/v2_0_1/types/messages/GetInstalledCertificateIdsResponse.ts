import type { CertificateHashDataType } from '../common/CertificateHashDataType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { GetCertificateIdUseEnum } from '../../enums/GetCertificateIdUseEnum.js';
import type { GetInstalledCertificateStatusEnum } from '../../enums/GetInstalledCertificateStatusEnum.js';

export interface CertificateHashDataChainType {
  customData?: CustomDataType;
  certificateHashData: CertificateHashDataType;
  certificateType: GetCertificateIdUseEnum;
  childCertificateHashData?: CertificateHashDataType[];
}

export interface GetInstalledCertificateIdsResponse {
  customData?: CustomDataType;
  status: GetInstalledCertificateStatusEnum;
  statusInfo?: StatusInfoType;
  certificateHashDataChain?: CertificateHashDataChainType[];
}
