import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "HeartbeatResponse",
  "type": "object",
  "properties": {
    "currentTime": {
      "type": "string",
      "format": "date-time"
    }
  },
  "additionalProperties": false,
  "required": [
    "currentTime"
  ]
} as const;

export const validateHeartbeatResponse: ValidateFunction = ajv.compile(schema);
