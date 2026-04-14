import type { CustomDataType } from '../common/CustomDataType.js';

import type { EnergyTransferModeEnum } from '../../enums/EnergyTransferModeEnum.js';

export interface NotifyAllowedEnergyTransferRequest {
  transactionId: string;
  allowedEnergyTransfer: EnergyTransferModeEnum[];
  customData?: CustomDataType;
}
