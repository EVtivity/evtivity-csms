import type { CustomDataType } from './CustomDataType.js';

export interface EVSEType {
  id: number;
  connectorId?: number;
  customData?: CustomDataType;
}
