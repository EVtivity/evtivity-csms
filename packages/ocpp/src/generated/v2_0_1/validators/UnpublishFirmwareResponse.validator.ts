import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:UnpublishFirmwareResponse",
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
    "UnpublishFirmwareStatusEnumType": {
      "description": "Indicates whether the Local Controller succeeded in unpublishing the firmware.\r\n",
      "javaType": "UnpublishFirmwareStatusEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "DownloadOngoing",
        "NoFirmware",
        "Unpublished"
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
      "$ref": "#/definitions/UnpublishFirmwareStatusEnumType"
    }
  },
  "required": [
    "status"
  ]
} as const;

export const validateUnpublishFirmwareResponse: ValidateFunction = ajv.compile(schema);

const removeAdditionalUnpublishFirmwareResponse: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateUnpublishFirmwareResponse for that.
 */
export function fitUnpublishFirmwareResponse(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalUnpublishFirmwareResponse(copy);
  return copy;
}
