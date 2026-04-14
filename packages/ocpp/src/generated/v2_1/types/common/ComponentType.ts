import type { CustomDataType } from './CustomDataType.js';
import type { EVSEType } from './EVSEType.js';

export interface ComponentType {
  evse?: EVSEType;
  name: string;
  instance?: string;
  customData?: CustomDataType;
}
