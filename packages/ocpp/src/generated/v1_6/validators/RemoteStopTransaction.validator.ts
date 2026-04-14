import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "RemoteStopTransactionRequest",
  "type": "object",
  "properties": {
    "transactionId": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "required": [
    "transactionId"
  ]
} as const;

export const validateRemoteStopTransaction: ValidateFunction = ajv.compile(schema);
