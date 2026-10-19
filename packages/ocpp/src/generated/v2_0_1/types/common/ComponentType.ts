import type { CustomDataType } from './CustomDataType.js';
import type { EVSEType } from './EVSEType.js';

export interface ComponentType {
  customData?: CustomDataType;
  evse?: EVSEType;
  name: string;
  instance?: string;
}
