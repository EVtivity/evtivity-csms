import type { CustomDataType } from '../common/CustomDataType.js';
import type { OCSPRequestDataType } from '../common/OCSPRequestDataType.js';

export interface GetCertificateStatusRequest {
  customData?: CustomDataType;
  ocspRequestData: OCSPRequestDataType;
}
