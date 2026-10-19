import type { CustomDataType } from './CustomDataType.js';

export interface EVSEType {
  customData?: CustomDataType;
  id: number;
  connectorId?: number;
}
