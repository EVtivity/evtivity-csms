import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:UnlockConnectorRequest",
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
    "evseId": {
      "description": "This contains the identifier of the EVSE for which a connector needs to be unlocked.\r\n",
      "type": "integer"
    },
    "connectorId": {
      "description": "This contains the identifier of the connector that needs to be unlocked.\r\n",
      "type": "integer"
    }
  },
  "required": [
    "evseId",
    "connectorId"
  ]
} as const;

export const validateUnlockConnectorRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalUnlockConnectorRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateUnlockConnectorRequest for that.
 */
export function fitUnlockConnectorRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalUnlockConnectorRequest(copy);
  return copy;
}
