import type { CertificateHashDataType } from '../common/CertificateHashDataType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenType } from '../common/IdTokenType.js';

export interface CustomerInformationRequest {
  customerCertificate?: CertificateHashDataType;
  idToken?: IdTokenType;
  requestId: number;
  report: boolean;
  clear: boolean;
  customerIdentifier?: string;
  customData?: CustomDataType;
}
