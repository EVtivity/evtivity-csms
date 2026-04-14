import type { CustomDataType } from '../common/CustomDataType.js';

export interface GetLocalListVersionResponse {
  versionNumber: number;
  customData?: CustomDataType;
}
