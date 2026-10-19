import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenType } from '../common/IdTokenType.js';

import type { ConnectorEnum } from '../../enums/ConnectorEnum.js';

export interface ReserveNowRequest {
  customData?: CustomDataType;
  id: number;
  expiryDateTime: string;
  connectorType?: ConnectorEnum;
  idToken: IdTokenType;
  evseId?: number;
  groupIdToken?: IdTokenType;
}
