import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "ClearChargingProfileRequest",
  "type": "object",
  "properties": {
    "id": {
      "type": "integer"
    },
    "connectorId": {
      "type": "integer"
    },
    "chargingProfilePurpose": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "ChargePointMaxProfile",
        "TxDefaultProfile",
        "TxProfile"
      ]
    },
    "stackLevel": {
      "type": "integer"
    }
  },
  "additionalProperties": false
} as const;

export const validateClearChargingProfile: ValidateFunction = ajv.compile(schema);
