import type { ConstantStreamDataType } from '../common/ConstantStreamDataType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

export interface GetPeriodicEventStreamResponse {
  constantStreamData?: ConstantStreamDataType[];
  customData?: CustomDataType;
}
