import type { CustomDataType } from './CustomDataType.js';

import type { MessageFormatEnum } from '../../enums/MessageFormatEnum.js';

export interface MessageContentType {
  format: MessageFormatEnum;
  language?: string;
  content: string;
  customData?: CustomDataType;
}
