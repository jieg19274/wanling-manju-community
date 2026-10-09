import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './store.js';
import { productionRules, type ProductionRules } from '../shared/production-rules.js';
const file = path.join(dataDir, 'production-defaults.json');
export function productionDefaults(): ProductionRules {
  return productionRules(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);
}
export function saveProductionDefaults(input: Partial<ProductionRules>) {
  const rules = productionRules({ ...productionDefaults(), ...input });
  writeFileSync(file + '.tmp', JSON.stringify(rules, null, 2));
  renameSync(file + '.tmp', file);
  return rules;
}
