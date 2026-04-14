import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "FirmwareStatusNotificationResponse",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateFirmwareStatusNotificationResponse: ValidateFunction = ajv.compile(schema);
