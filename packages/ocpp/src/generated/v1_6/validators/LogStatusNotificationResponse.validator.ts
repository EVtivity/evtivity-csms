import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "LogStatusNotificationResponse",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateLogStatusNotificationResponse: ValidateFunction = ajv.compile(schema);
