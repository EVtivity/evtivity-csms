import type { ChargingProfileType } from '../common/ChargingProfileType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenType } from '../common/IdTokenType.js';

export interface RequestStartTransactionRequest {
  evseId?: number;
  groupIdToken?: IdTokenType;
  idToken: IdTokenType;
  remoteStartId: number;
  chargingProfile?: ChargingProfileType;
  customData?: CustomDataType;
}
