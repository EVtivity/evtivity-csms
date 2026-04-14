import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "BootNotificationResponse",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Accepted",
        "Pending",
        "Rejected"
      ]
    },
    "currentTime": {
      "type": "string",
      "format": "date-time"
    },
    "interval": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "required": [
    "status",
    "currentTime",
    "interval"
  ]
} as const;

export const validateBootNotificationResponse: ValidateFunction = ajv.compile(schema);
