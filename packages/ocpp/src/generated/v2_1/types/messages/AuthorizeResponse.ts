import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenInfoType } from '../common/IdTokenInfoType.js';
import type { TariffType } from '../common/TariffType.js';

import type { AuthorizeCertificateStatusEnum } from '../../enums/AuthorizeCertificateStatusEnum.js';
import type { EnergyTransferModeEnum } from '../../enums/EnergyTransferModeEnum.js';

export interface AuthorizeResponse {
  idTokenInfo: IdTokenInfoType;
  certificateStatus?: AuthorizeCertificateStatusEnum;
  allowedEnergyTransfer?: EnergyTransferModeEnum[];
  tariff?: TariffType;
  customData?: CustomDataType;
}
