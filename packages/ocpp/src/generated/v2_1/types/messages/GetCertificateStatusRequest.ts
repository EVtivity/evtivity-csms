import type { CustomDataType } from '../common/CustomDataType.js';
import type { OCSPRequestDataType } from '../common/OCSPRequestDataType.js';

export interface GetCertificateStatusRequest {
  ocspRequestData: OCSPRequestDataType;
  customData?: CustomDataType;
}
