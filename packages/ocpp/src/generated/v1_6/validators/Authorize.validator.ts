import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "AuthorizeRequest",
  "type": "object",
  "properties": {
    "idTag": {
      "type": "string",
      "maxLength": 20
    }
  },
  "additionalProperties": false,
  "required": [
    "idTag"
  ]
} as const;

export const validateAuthorize: ValidateFunction = ajv.compile(schema);
