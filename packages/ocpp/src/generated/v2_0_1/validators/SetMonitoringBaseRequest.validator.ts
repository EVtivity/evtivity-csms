import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:SetMonitoringBaseRequest",
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
    "MonitoringBaseEnumType": {
      "description": "Specify which monitoring base will be set\r\n",
      "javaType": "MonitoringBaseEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "All",
        "FactoryDefault",
        "HardWiredOnly"
      ]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "monitoringBase": {
      "$ref": "#/definitions/MonitoringBaseEnumType"
    }
  },
  "required": [
    "monitoringBase"
  ]
} as const;

export const validateSetMonitoringBaseRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalSetMonitoringBaseRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateSetMonitoringBaseRequest for that.
 */
export function fitSetMonitoringBaseRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalSetMonitoringBaseRequest(copy);
  return copy;
}
