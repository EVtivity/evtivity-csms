import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:DataTransferRequest",
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
    "messageId": {
      "description": "May be used to indicate a specific message or implementation.\r\n",
      "type": "string",
      "maxLength": 50
    },
    "data": {
      "description": "Data without specified length or format. This needs to be decided by both parties (Open to implementation).\r\n"
    },
    "vendorId": {
      "description": "This identifies the Vendor specific implementation\r\n\r\n",
      "type": "string",
      "maxLength": 255
    }
  },
  "required": [
    "vendorId"
  ]
} as const;

export const validateDataTransferRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalDataTransferRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateDataTransferRequest for that.
 */
export function fitDataTransferRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalDataTransferRequest(copy);
  return copy;
}
