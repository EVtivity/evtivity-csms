import type { CustomDataType } from './CustomDataType.js';

export interface VariableType {
  name: string;
  instance?: string;
  customData?: CustomDataType;
}
