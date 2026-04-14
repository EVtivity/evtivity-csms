import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "StatusNotificationResponse",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateStatusNotificationResponse: ValidateFunction = ajv.compile(schema);
