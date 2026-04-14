import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "ChangeConfigurationRequest",
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "maxLength": 50
    },
    "value": {
      "type": "string",
      "maxLength": 500
    }
  },
  "additionalProperties": false,
  "required": [
    "key",
    "value"
  ]
} as const;

export const validateChangeConfiguration: ValidateFunction = ajv.compile(schema);
