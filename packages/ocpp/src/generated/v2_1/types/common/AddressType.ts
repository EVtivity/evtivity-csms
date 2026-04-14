import type { CustomDataType } from './CustomDataType.js';

export interface AddressType {
  name: string;
  address1: string;
  address2?: string;
  city: string;
  postalCode?: string;
  country: string;
  customData?: CustomDataType;
}
