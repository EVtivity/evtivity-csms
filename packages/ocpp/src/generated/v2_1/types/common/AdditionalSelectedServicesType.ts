import type { CustomDataType } from './CustomDataType.js';
import type { RationalNumberType } from './RationalNumberType.js';

export interface AdditionalSelectedServicesType {
  serviceFee: RationalNumberType;
  serviceName: string;
  customData?: CustomDataType;
}
