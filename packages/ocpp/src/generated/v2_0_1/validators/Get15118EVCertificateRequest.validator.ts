import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:Get15118EVCertificateRequest",
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
    "CertificateActionEnumType": {
      "description": "Defines whether certificate needs to be installed or updated.\r\n",
      "javaType": "CertificateActionEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Install",
        "Update"
      ]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "iso15118SchemaVersion": {
      "description": "Schema version currently used for the 15118 session between EV and Charging Station. Needed for parsing of the EXI stream by the CSMS.\r\n\r\n",
      "type": "string",
      "maxLength": 50
    },
    "action": {
      "$ref": "#/definitions/CertificateActionEnumType"
    },
    "exiRequest": {
      "description": "Raw CertificateInstallationReq request from EV, Base64 encoded.\r\n",
      "type": "string",
      "maxLength": 5600
    }
  },
  "required": [
    "iso15118SchemaVersion",
    "action",
    "exiRequest"
  ]
} as const;

export const validateGet15118EVCertificateRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalGet15118EVCertificateRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateGet15118EVCertificateRequest for that.
 */
export function fitGet15118EVCertificateRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalGet15118EVCertificateRequest(copy);
  return copy;
}
