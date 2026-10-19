import type { CustomDataType } from '../common/CustomDataType.js';

import type { BootReasonEnum } from '../../enums/BootReasonEnum.js';

export interface ChargingStationType {
  customData?: CustomDataType;
  serialNumber?: string;
  model: string;
  modem?: ModemType;
  vendorName: string;
  firmwareVersion?: string;
}

export interface ModemType {
  customData?: CustomDataType;
  iccid?: string;
  imsi?: string;
}

export interface BootNotificationRequest {
  customData?: CustomDataType;
  chargingStation: ChargingStationType;
  reason: BootReasonEnum;
}
