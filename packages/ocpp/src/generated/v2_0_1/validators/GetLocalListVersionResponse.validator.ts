import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:GetLocalListVersionResponse",
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
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "versionNumber": {
      "description": "This contains the current version number of the local authorization list in the Charging Station.\r\n",
      "type": "integer"
    }
  },
  "required": [
    "versionNumber"
  ]
} as const;

export const validateGetLocalListVersionResponse: ValidateFunction = ajv.compile(schema);

const removeAdditionalGetLocalListVersionResponse: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateGetLocalListVersionResponse for that.
 */
export function fitGetLocalListVersionResponse(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalGetLocalListVersionResponse(copy);
  return copy;
}
