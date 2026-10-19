import type { CustomDataType } from './CustomDataType.js';

import type { MessageFormatEnum } from '../../enums/MessageFormatEnum.js';

export interface MessageContentType {
  customData?: CustomDataType;
  format: MessageFormatEnum;
  language?: string;
  content: string;
}
