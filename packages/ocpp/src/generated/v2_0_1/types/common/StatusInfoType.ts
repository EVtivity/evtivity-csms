import type { CustomDataType } from './CustomDataType.js';

export interface StatusInfoType {
  customData?: CustomDataType;
  reasonCode: string;
  additionalInfo?: string;
}
