import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:UnpublishFirmwareRequest",
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
    "checksum": {
      "description": "The MD5 checksum over the entire firmware file as a hexadecimal string of length 32. \r\n",
      "type": "string",
      "maxLength": 32
    }
  },
  "required": [
    "checksum"
  ]
} as const;

export const validateUnpublishFirmwareRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalUnpublishFirmwareRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateUnpublishFirmwareRequest for that.
 */
export function fitUnpublishFirmwareRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalUnpublishFirmwareRequest(copy);
  return copy;
}
