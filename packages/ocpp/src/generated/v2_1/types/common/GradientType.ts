import type { CustomDataType } from './CustomDataType.js';

export interface GradientType {
  priority: number;
  gradient: number;
  softGradient: number;
  customData?: CustomDataType;
}
