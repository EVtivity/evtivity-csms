import type { CustomDataType } from './CustomDataType.js';

export interface SignedMeterValueType {
  signedMeterData: string;
  signingMethod?: string;
  encodingMethod: string;
  publicKey?: string;
  customData?: CustomDataType;
}
