import type { CustomDataType } from '../common/CustomDataType.js';

import type { APNAuthenticationEnum } from '../../enums/APNAuthenticationEnum.js';
import type { OCPPInterfaceEnum } from '../../enums/OCPPInterfaceEnum.js';
import type { OCPPTransportEnum } from '../../enums/OCPPTransportEnum.js';
import type { OCPPVersionEnum } from '../../enums/OCPPVersionEnum.js';
import type { VPNEnum } from '../../enums/VPNEnum.js';

export interface APNType {
  apn: string;
  apnUserName?: string;
  apnPassword?: string;
  simPin?: number;
  preferredNetwork?: string;
  useOnlyPreferredNetwork?: boolean;
  apnAuthentication: APNAuthenticationEnum;
  customData?: CustomDataType;
}

export interface NetworkConnectionProfileType {
  apn?: APNType;
  ocppVersion?: OCPPVersionEnum;
  ocppInterface: OCPPInterfaceEnum;
  ocppTransport: OCPPTransportEnum;
  messageTimeout: number;
  ocppCsmsUrl: string;
  securityProfile: number;
  identity?: string;
  basicAuthPassword?: string;
  vpn?: VPNType;
  customData?: CustomDataType;
}

export interface VPNType {
  server: string;
  user: string;
  group?: string;
  password: string;
  key: string;
  type: VPNEnum;
  customData?: CustomDataType;
}

export interface SetNetworkProfileRequest {
  configurationSlot: number;
  connectionData: NetworkConnectionProfileType;
  customData?: CustomDataType;
}
