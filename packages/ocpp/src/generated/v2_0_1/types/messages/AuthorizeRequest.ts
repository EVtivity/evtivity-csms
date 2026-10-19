import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenType } from '../common/IdTokenType.js';
import type { OCSPRequestDataType } from '../common/OCSPRequestDataType.js';

export interface AuthorizeRequest {
  customData?: CustomDataType;
  idToken: IdTokenType;
  certificate?: string;
  iso15118CertificateHashData?: OCSPRequestDataType[];
}
