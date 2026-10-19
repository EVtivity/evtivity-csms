import type { CustomDataType } from '../common/CustomDataType.js';

export interface GetLocalListVersionResponse {
  customData?: CustomDataType;
  versionNumber: number;
}
