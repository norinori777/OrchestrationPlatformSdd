import type { OrchestrationDefinition } from '../types.ts';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schemaPath = path.resolve(process.cwd(), 'src', 'product', 'orchestrations', 'orchestration.schema.json');
let compiled: any = null;

function loadCompiler() {
  if (compiled) return compiled;
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw);
  const ajv = new Ajv2020({ allErrors: true, strict: false, meta: true });
  addFormats(ajv as any);
  compiled = (ajv as any).compile(schema);
  return compiled;
}

export function validateOrchestrationDefinition(def: unknown): { valid: boolean; errors: string[] } {
  const validate = loadCompiler();
  const valid = validate(def);
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors ?? []).map((e: any) => `${e.instancePath || '/'} ${e.message}`).filter(Boolean);
  return { valid: false, errors };
}

export function assertValidOrchestrationDefinition(def: unknown): OrchestrationDefinition {
  const res = validateOrchestrationDefinition(def);
  if (!res.valid) throw new Error(`Invalid orchestration definition: ${res.errors.join('; ')}`);
  return def as OrchestrationDefinition;
}

export default validateOrchestrationDefinition;
