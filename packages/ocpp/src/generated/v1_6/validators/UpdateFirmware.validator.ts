import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "UpdateFirmwareRequest",
  "type": "object",
  "properties": {
    "location": {
      "type": "string",
      "format": "uri"
    },
    "retries": {
      "type": "integer"
    },
    "retrieveDate": {
      "type": "string",
      "format": "date-time"
    },
    "retryInterval": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "required": [
    "location",
    "retrieveDate"
  ]
} as const;

export const validateUpdateFirmware: ValidateFunction = ajv.compile(schema);
