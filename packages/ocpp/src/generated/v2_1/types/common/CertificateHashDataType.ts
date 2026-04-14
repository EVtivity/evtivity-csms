import type { CustomDataType } from './CustomDataType.js';

import type { HashAlgorithmEnum } from '../../enums/HashAlgorithmEnum.js';

export interface CertificateHashDataType {
  hashAlgorithm: HashAlgorithmEnum;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
  customData?: CustomDataType;
}
