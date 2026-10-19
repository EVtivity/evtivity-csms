import type { CustomDataType } from './CustomDataType.js';

import type { HashAlgorithmEnum } from '../../enums/HashAlgorithmEnum.js';

export interface OCSPRequestDataType {
  customData?: CustomDataType;
  hashAlgorithm: HashAlgorithmEnum;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
  responderURL: string;
}
