import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "UnlockConnectorRequest",
  "type": "object",
  "properties": {
    "connectorId": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "required": [
    "connectorId"
  ]
} as const;

export const validateUnlockConnector: ValidateFunction = ajv.compile(schema);
