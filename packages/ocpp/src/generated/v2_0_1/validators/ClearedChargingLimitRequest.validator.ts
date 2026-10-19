import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:ClearedChargingLimitRequest",
  "comment": "OCPP 2.0.1 FINAL",
  "definitions": {
    "CustomDataType": {
      "description": "This class does not get 'AdditionalProperties = false' in the schema generation, so it can be extended with arbitrary JSON properties to allow adding custom data.",
      "javaType": "CustomData",
      "type": "object",
      "properties": {
        "vendorId": {
          "type": "string",
          "maxLength": 255
        }
      },
      "required": [
        "vendorId"
      ]
    },
    "ChargingLimitSourceEnumType": {
      "description": "Source of the charging limit.\r\n",
      "javaType": "ChargingLimitSourceEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "EMS",
        "Other",
        "SO",
        "CSO"
      ]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "chargingLimitSource": {
      "$ref": "#/definitions/ChargingLimitSourceEnumType"
    },
    "evseId": {
      "description": "EVSE Identifier.\r\n",
      "type": "integer"
    }
  },
  "required": [
    "chargingLimitSource"
  ]
} as const;

export const validateClearedChargingLimitRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalClearedChargingLimitRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateClearedChargingLimitRequest for that.
 */
export function fitClearedChargingLimitRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalClearedChargingLimitRequest(copy);
  return copy;
}
