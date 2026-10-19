import type { CustomDataType } from './CustomDataType.js';

export interface SignedMeterValueType {
  customData?: CustomDataType;
  signedMeterData: string;
  signingMethod: string;
  encodingMethod: string;
  publicKey: string;
}
