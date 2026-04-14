import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetLocalListVersionResponse",
  "type": "object",
  "properties": {
    "listVersion": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "required": [
    "listVersion"
  ]
} as const;

export const validateGetLocalListVersionResponse: ValidateFunction = ajv.compile(schema);
