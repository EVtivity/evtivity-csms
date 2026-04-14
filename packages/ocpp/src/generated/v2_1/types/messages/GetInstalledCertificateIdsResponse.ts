import type { CertificateHashDataType } from '../common/CertificateHashDataType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { GetCertificateIdUseEnum } from '../../enums/GetCertificateIdUseEnum.js';
import type { GetInstalledCertificateStatusEnum } from '../../enums/GetInstalledCertificateStatusEnum.js';

export interface CertificateHashDataChainType {
  certificateHashData: CertificateHashDataType;
  certificateType: GetCertificateIdUseEnum;
  childCertificateHashData?: CertificateHashDataType[];
  customData?: CustomDataType;
}

export interface GetInstalledCertificateIdsResponse {
  status: GetInstalledCertificateStatusEnum;
  statusInfo?: StatusInfoType;
  certificateHashDataChain?: CertificateHashDataChainType[];
  customData?: CustomDataType;
}
