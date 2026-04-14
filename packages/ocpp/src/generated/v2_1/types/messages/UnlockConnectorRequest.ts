import type { CustomDataType } from '../common/CustomDataType.js';

export interface UnlockConnectorRequest {
  evseId: number;
  connectorId: number;
  customData?: CustomDataType;
}
