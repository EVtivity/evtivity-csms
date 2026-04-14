import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "UnlockConnectorResponse",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Unlocked",
        "UnlockFailed",
        "NotSupported"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateUnlockConnectorResponse: ValidateFunction = ajv.compile(schema);
