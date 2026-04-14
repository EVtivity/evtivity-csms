import type { CertificateHashDataType } from '../common/CertificateHashDataType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

export interface DeleteCertificateRequest {
  certificateHashData: CertificateHashDataType;
  customData?: CustomDataType;
}
