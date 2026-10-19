import type { CustomDataType } from './CustomDataType.js';

export interface VariableType {
  customData?: CustomDataType;
  name: string;
  instance?: string;
}
