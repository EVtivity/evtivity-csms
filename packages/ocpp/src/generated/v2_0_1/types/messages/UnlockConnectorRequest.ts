import type { CustomDataType } from '../common/CustomDataType.js';

export interface UnlockConnectorRequest {
  customData?: CustomDataType;
  evseId: number;
  connectorId: number;
}
