import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "AuthorizeResponse",
  "type": "object",
  "properties": {
    "idTagInfo": {
      "type": "object",
      "properties": {
        "expiryDate": {
          "type": "string",
          "format": "date-time"
        },
        "parentIdTag": {
          "type": "string",
          "maxLength": 20
        },
        "status": {
          "type": "string",
          "additionalProperties": false,
          "enum": [
            "Accepted",
            "Blocked",
            "Expired",
            "Invalid",
            "ConcurrentTx"
          ]
        }
      },
      "additionalProperties": false,
      "required": [
        "status"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "idTagInfo"
  ]
} as const;

export const validateAuthorizeResponse: ValidateFunction = ajv.compile(schema);
