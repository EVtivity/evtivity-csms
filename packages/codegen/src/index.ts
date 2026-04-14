// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from './config.js';
import { parseAllSchemas } from './parsers/schema-parser.js';
import { groupActionPairs } from './parsers/action-extractor.js';
import { collectAllEnums } from './parsers/enum-extractor.js';
import { classifyTypes } from './parsers/type-extractor.js';
import { generateEnumFile } from './generators/enum-generator.js';
import {
  generateMessageTypeFile,
  generateCommonTypeFile,
} from './generators/typescript-generator.js';
import { generateValidatorFile, generateAjvSetupFile } from './generators/validator-generator.js';
import { generateRegistryFile } from './generators/registry-generator.js';
import { generateHandlerFile } from './generators/handler-stub-generator.js';
import {
  generateEnumsIndex,
  generateCommonTypesIndex,
  generateMessagesIndex,
  generateValidatorsIndex,
  generateRootIndex,
} from './generators/index-generator.js';

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf-8');
}

function run(): void {
  const versionArg = process.argv.find((a: string) => a.startsWith('--version='));
  if (versionArg != null) {
    const version = versionArg.split('=')[1];
    if (version != null) {
      runWithVersion(version);
      return;
    }
  }

  const idx = process.argv.indexOf('--version');
  if (idx !== -1) {
    const version = process.argv[idx + 1];
    if (version != null) {
      runWithVersion(version);
      return;
    }
  }

  console.error('Usage: codegen --version <version>');
  process.exit(1);
}

function runWithVersion(version: string): void {
  const config = resolveConfig(version);

  console.log(`Parsing schemas from ${config.schemasDir}...`);
  const schemas = parseAllSchemas(config.schemasDir);
  console.log(`Parsed ${String(schemas.length)} schemas.`);

  const actionPairs = groupActionPairs(schemas);
  console.log(`Found ${String(actionPairs.size)} action pairs.`);

  const allEnums = collectAllEnums(schemas);
  console.log(`Found ${String(allEnums.size)} unique enums.`);

  const classification = classifyTypes(schemas);
  console.log(`Found ${String(classification.commonTypes.size)} common types.`);

  const enumsDir = path.join(config.outputDir, 'enums');
  const commonDir = path.join(config.outputDir, 'types', 'common');
  const messagesDir = path.join(config.outputDir, 'types', 'messages');
  const validatorsDir = path.join(config.outputDir, 'validators');

  ensureDir(enumsDir);
  ensureDir(commonDir);
  ensureDir(messagesDir);
  ensureDir(validatorsDir);

  console.log('Generating enums...');
  for (const enumDef of allEnums.values()) {
    writeFile(path.join(enumsDir, `${enumDef.typeName}.ts`), generateEnumFile(enumDef));
  }
  writeFile(path.join(enumsDir, 'index.ts'), generateEnumsIndex(allEnums));

  console.log('Generating common types...');
  for (const [typeName, def] of classification.commonTypes.entries()) {
    writeFile(
      path.join(commonDir, `${typeName}.ts`),
      generateCommonTypeFile(def, classification.commonTypes, allEnums),
    );
  }
  writeFile(path.join(commonDir, 'index.ts'), generateCommonTypesIndex(classification.commonTypes));

  console.log('Generating message types...');
  for (const schema of schemas) {
    const messageName = schema.fileName.replace('.json', '');
    writeFile(
      path.join(messagesDir, `${messageName}.ts`),
      generateMessageTypeFile(schema, classification, allEnums),
    );
  }
  writeFile(path.join(messagesDir, 'index.ts'), generateMessagesIndex(actionPairs));

  console.log('Generating validators...');
  writeFile(path.join(validatorsDir, '_ajv.ts'), generateAjvSetupFile());
  for (const schema of schemas) {
    const messageName = schema.fileName.replace('.json', '');
    writeFile(
      path.join(validatorsDir, `${messageName}.validator.ts`),
      generateValidatorFile(schema),
    );
  }
  writeFile(path.join(validatorsDir, 'index.ts'), generateValidatorsIndex(actionPairs));

  console.log('Generating registry...');
  writeFile(path.join(config.outputDir, 'registry.ts'), generateRegistryFile(actionPairs));

  console.log('Generating handler interfaces...');
  writeFile(path.join(config.outputDir, 'handlers.ts'), generateHandlerFile(actionPairs));

  console.log('Generating root index...');
  writeFile(path.join(config.outputDir, 'index.ts'), generateRootIndex());

  console.log('Done.');
}

run();
