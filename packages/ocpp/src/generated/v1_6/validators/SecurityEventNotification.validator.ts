import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "SecurityEventNotificationRequest",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "maxLength": 50
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "techInfo": {
      "type": "string",
      "maxLength": 255
    }
  },
  "additionalProperties": false,
  "required": [
    "type",
    "timestamp"
  ]
} as const;

export const validateSecurityEventNotification: ValidateFunction = ajv.compile(schema);
