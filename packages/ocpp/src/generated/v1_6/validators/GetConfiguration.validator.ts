import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetConfigurationRequest",
  "type": "object",
  "properties": {
    "key": {
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 50
      }
    }
  },
  "additionalProperties": false
} as const;

export const validateGetConfiguration: ValidateFunction = ajv.compile(schema);
