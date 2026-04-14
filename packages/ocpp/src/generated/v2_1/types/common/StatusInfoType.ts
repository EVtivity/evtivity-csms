import type { CustomDataType } from './CustomDataType.js';

export interface StatusInfoType {
  reasonCode: string;
  additionalInfo?: string;
  customData?: CustomDataType;
}
