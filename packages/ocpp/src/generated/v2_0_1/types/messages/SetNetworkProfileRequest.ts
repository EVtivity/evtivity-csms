import type { CustomDataType } from '../common/CustomDataType.js';

import type { APNAuthenticationEnum } from '../../enums/APNAuthenticationEnum.js';
import type { OCPPInterfaceEnum } from '../../enums/OCPPInterfaceEnum.js';
import type { OCPPTransportEnum } from '../../enums/OCPPTransportEnum.js';
import type { OCPPVersionEnum } from '../../enums/OCPPVersionEnum.js';
import type { VPNEnum } from '../../enums/VPNEnum.js';

export interface APNType {
  customData?: CustomDataType;
  apn: string;
  apnUserName?: string;
  apnPassword?: string;
  simPin?: number;
  preferredNetwork?: string;
  useOnlyPreferredNetwork?: boolean;
  apnAuthentication: APNAuthenticationEnum;
}

export interface NetworkConnectionProfileType {
  customData?: CustomDataType;
  apn?: APNType;
  ocppVersion: OCPPVersionEnum;
  ocppTransport: OCPPTransportEnum;
  ocppCsmsUrl: string;
  messageTimeout: number;
  securityProfile: number;
  ocppInterface: OCPPInterfaceEnum;
  vpn?: VPNType;
}

export interface VPNType {
  customData?: CustomDataType;
  server: string;
  user: string;
  group?: string;
  password: string;
  key: string;
  type: VPNEnum;
}

export interface SetNetworkProfileRequest {
  customData?: CustomDataType;
  configurationSlot: number;
  connectionData: NetworkConnectionProfileType;
}
