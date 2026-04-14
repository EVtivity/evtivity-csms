import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "DataTransferResponse",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Accepted",
        "Rejected",
        "UnknownMessageId",
        "UnknownVendorId"
      ]
    },
    "data": {
      "type": "string"
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateDataTransferResponse: ValidateFunction = ajv.compile(schema);
