import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "SecurityEventNotificationResponse",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateSecurityEventNotificationResponse: ValidateFunction = ajv.compile(schema);
