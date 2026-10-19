import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:ClearChargingProfileResponse",
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
    "ClearChargingProfileStatusEnumType": {
      "description": "Indicates if the Charging Station was able to execute the request.\r\n",
      "javaType": "ClearChargingProfileStatusEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Accepted",
        "Unknown"
      ]
    },
    "StatusInfoType": {
      "description": "Element providing more information about the status.\r\n",
      "javaType": "StatusInfo",
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "customData": {
          "$ref": "#/definitions/CustomDataType"
        },
        "reasonCode": {
          "description": "A predefined code for the reason why the status is returned in this response. The string is case-insensitive.\r\n",
          "type": "string",
          "maxLength": 20
        },
        "additionalInfo": {
          "description": "Additional text to provide detailed information.\r\n",
          "type": "string",
          "maxLength": 512
        }
      },
      "required": [
        "reasonCode"
      ]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "status": {
      "$ref": "#/definitions/ClearChargingProfileStatusEnumType"
    },
    "statusInfo": {
      "$ref": "#/definitions/StatusInfoType"
    }
  },
  "required": [
    "status"
  ]
} as const;

export const validateClearChargingProfileResponse: ValidateFunction = ajv.compile(schema);

const removeAdditionalClearChargingProfileResponse: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateClearChargingProfileResponse for that.
 */
export function fitClearChargingProfileResponse(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalClearChargingProfileResponse(copy);
  return copy;
}
