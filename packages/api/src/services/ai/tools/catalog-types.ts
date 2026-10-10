// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** Types of the generated tool catalog (`catalog.ts`, written by `generate-ai-tools.ts`). */

export type AiToolMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A JSON schema object as the OpenAPI spec emits it. */
export type JsonSchema = Record<string, unknown>;

export interface AiCatalogTool {
  /** Tool name the model sees: the operationId in snake_case. */
  name: string;
  operationId: string;
  description: string;
  /** The operation's first OpenAPI tag; the router picks categories. */
  category: string;
  method: AiToolMethod;
  /** OpenAPI path with `{param}` placeholders, such as `/v1/stations/{id}`. */
  pathTemplate: string;
  pathParams: readonly string[];
  queryParams: readonly string[];
  bodyParams: readonly string[];
  /**
   * Arguments object schema. When `strict` is true it is strict-compatible:
   * every object closed (`additionalProperties: false`) and every property
   * required, the optional ones nullable.
   */
  parameters: JsonSchema;
  strict: boolean;
  /**
   * The arguments as the operation defines them (its own required fields and
   * constraints). The server validates every call against it before running
   * the tool, whatever the provider enforced.
   */
  validation: JsonSchema;
  /** Every property name in the 200 or 201 response schema, at any depth. */
  responseFields: readonly string[];
}

export interface AiCatalogCategory {
  tag: string;
  description: string;
}

export interface AiCatalogOperation {
  operationId: string;
  method: AiToolMethod;
  path: string;
}
