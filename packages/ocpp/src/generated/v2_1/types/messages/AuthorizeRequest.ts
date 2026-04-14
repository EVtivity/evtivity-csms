import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenType } from '../common/IdTokenType.js';
import type { OCSPRequestDataType } from '../common/OCSPRequestDataType.js';

export interface AuthorizeRequest {
  idToken: IdTokenType;
  certificate?: string;
  iso15118CertificateHashData?: OCSPRequestDataType[];
  customData?: CustomDataType;
}
