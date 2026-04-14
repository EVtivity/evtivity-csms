import type { CustomDataType } from '../common/CustomDataType.js';

import type { BootReasonEnum } from '../../enums/BootReasonEnum.js';

export interface ChargingStationType {
  serialNumber?: string;
  model: string;
  modem?: ModemType;
  vendorName: string;
  firmwareVersion?: string;
  customData?: CustomDataType;
}

export interface ModemType {
  iccid?: string;
  imsi?: string;
  customData?: CustomDataType;
}

export interface BootNotificationRequest {
  chargingStation: ChargingStationType;
  reason: BootReasonEnum;
  customData?: CustomDataType;
}
