import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:SetChargingProfileResponse",
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
    "ChargingProfileStatusEnumType": {
      "description": "Returns whether the Charging Station has been able to process the message successfully. This does not guarantee the schedule will be followed to the letter. There might be other constraints the Charging Station may need to take into account.\r\n",
      "javaType": "ChargingProfileStatusEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Accepted",
        "Rejected"
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
      "$ref": "#/definitions/ChargingProfileStatusEnumType"
    },
    "statusInfo": {
      "$ref": "#/definitions/StatusInfoType"
    }
  },
  "required": [
    "status"
  ]
} as const;

export const validateSetChargingProfileResponse: ValidateFunction = ajv.compile(schema);

const removeAdditionalSetChargingProfileResponse: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateSetChargingProfileResponse for that.
 */
export function fitSetChargingProfileResponse(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalSetChargingProfileResponse(copy);
  return copy;
}
