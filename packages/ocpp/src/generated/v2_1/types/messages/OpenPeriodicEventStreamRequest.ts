import type { ConstantStreamDataType } from '../common/ConstantStreamDataType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

export interface OpenPeriodicEventStreamRequest {
  constantStreamData: ConstantStreamDataType;
  customData?: CustomDataType;
}
