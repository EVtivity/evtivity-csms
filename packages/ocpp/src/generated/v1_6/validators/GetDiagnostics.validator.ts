import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetDiagnosticsRequest",
  "type": "object",
  "properties": {
    "location": {
      "type": "string",
      "format": "uri"
    },
    "retries": {
      "type": "integer"
    },
    "retryInterval": {
      "type": "integer"
    },
    "startTime": {
      "type": "string",
      "format": "date-time"
    },
    "stopTime": {
      "type": "string",
      "format": "date-time"
    }
  },
  "additionalProperties": false,
  "required": [
    "location"
  ]
} as const;

export const validateGetDiagnostics: ValidateFunction = ajv.compile(schema);
