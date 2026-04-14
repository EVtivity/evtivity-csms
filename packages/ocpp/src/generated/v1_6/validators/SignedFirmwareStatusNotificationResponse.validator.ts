import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "SignedFirmwareStatusNotificationResponse",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateSignedFirmwareStatusNotificationResponse: ValidateFunction = ajv.compile(schema);
