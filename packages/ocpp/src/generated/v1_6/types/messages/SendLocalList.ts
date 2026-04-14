import type { IdTagInfoType } from '../common/IdTagInfoType.js';

import type { SendLocalListUpdateTypeEnum } from '../../enums/SendLocalListUpdateTypeEnum.js';

export interface LocalAuthorizationListType {
  idTag: string;
  idTagInfo?: IdTagInfoType;
}

export interface SendLocalList {
  listVersion: number;
  localAuthorizationList?: LocalAuthorizationListType[];
  updateType: SendLocalListUpdateTypeEnum;
}
