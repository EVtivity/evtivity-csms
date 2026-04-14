import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "DataTransferRequest",
  "type": "object",
  "properties": {
    "vendorId": {
      "type": "string",
      "maxLength": 255
    },
    "messageId": {
      "type": "string",
      "maxLength": 50
    },
    "data": {
      "type": "string"
    }
  },
  "additionalProperties": false,
  "required": [
    "vendorId"
  ]
} as const;

export const validateDataTransfer: ValidateFunction = ajv.compile(schema);
