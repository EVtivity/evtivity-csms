import type { ComponentType } from './ComponentType.js';
import type { CustomDataType } from './CustomDataType.js';
import type { VariableType } from './VariableType.js';

export interface ComponentVariableType {
  component: ComponentType;
  variable?: VariableType;
  customData?: CustomDataType;
}
