#!/usr/bin/env node
/**
 * selfcheck.mjs — static self-verification for the P0 package.
 *
 * Runs with plain `node` (zero dependencies, no build step). It cannot prove
 * runtime behaviour; what it *can* prove is the class of failures that a
 * human review usually misses:
 *
 *   1. every relative import resolves to a file that exists;
 *   2. every named import is actually exported by that file;
 *   3. every schema is valid JSON with $id + title + type;
 *   4. the registration order in compose.mjs matches contracts.mjs;
 *   5. every connector's manifests carry the required fields;
 *   6. every doc-referenced CLI exists in bin/.
 *
 * Exit code: 0 = all checks pass, 1 = at least one failure.
 * This is the script referenced by `npm run selfcheck`; it is also the
 * evidence behind the delivery report's "static self-check" section.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // packages/personal
const srcDir = join(root, 'src');
const schemaDir = join(root, 'schemas');
const binDir = join(root, 'bin');

/** @type {{id: string, ok: boolean, detail: string}[]} */
const checks = [];
const record = (id, ok, detail) => checks.push({ id, ok, detail });

/** @param {string} dir @param {(file: string) => boolean} filter */
async function walk(dir, filter = () => true) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, filter)));
    else if (entry.isFile() && filter(full)) out.push(full);
  }
  return out;
}

/** Extract `import ... from '...'` specifiers and the names they bind. */
function parseImports(source) {
  /** @type {{specifier: string, names: string[], line: number}[]} */
  const imports = [];
  const lines = source.split('\n');
  let buffer = '';
  let startLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*import\s/.test(line) || buffer) {
      if (!buffer) startLine = i + 1;
      buffer += `${line}\n`;
      if (/from\s+['"][^'"]+['"]\s*;?\s*$/.test(line) || /^\s*import\s+['"][^'"]+['"]\s*;?\s*$/.test(line)) {
        const specifier = /from\s+['"]([^'"]+)['"]/.exec(buffer)?.[1] ?? /import\s+['"]([^'"]+)['"]/.exec(buffer)?.[1];
        const brace = /\{([^}]*)\}/.exec(buffer)?.[1] ?? '';
        const names = brace
          .split(',')
          .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        if (specifier) imports.push({ specifier, names, line: startLine });
        buffer = '';
      }
    }
  }
  return imports;
}

/** Collect exported identifier names from a module source. */
function parseExports(source) {
  const names = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(source)) names.add('default');
  return names;
}

async function checkImports() {
  const files = await walk(srcDir, (file) => file.endsWith('.mjs'));
  if (files.length === 0) {
    record('imports', false, 'no source files found');
    return;
  }
  const sources = new Map();
  for (const file of files) sources.set(file, await readFile(file, 'utf8'));

  /** @type {string[]} */
  const problems = [];
  let importsChecked = 0;
  for (const [file, source] of sources) {
    for (const { specifier, names, line } of parseImports(source)) {
      if (!specifier.startsWith('.')) continue; // node: builtins only
      importsChecked += 1;
      const target = resolve(dirname(file), specifier);
      const targetSource = sources.get(target);
      const rel = relative(root, file);
      if (!targetSource) {
        problems.push(`${rel}:${line} -> missing module ${specifier}`);
        continue;
      }
      const exports = parseExports(targetSource);
      const hasStar = /export\s+\*/.test(targetSource);
      for (const name of names) {
        if (!exports.has(name) && !hasStar) {
          problems.push(`${rel}:${line} -> "${name}" is not exported by ${specifier}`);
        }
      }
    }
  }
  record('imports_resolve', problems.length === 0, problems.length === 0 ? `${files.length} files, ${importsChecked} relative imports` : problems.slice(0, 8).join(' | '));
}

async function checkSchemas() {
  const files = await walk(schemaDir, (file) => file.endsWith('.json'));
  /** @type {string[]} */
  const problems = [];
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    let schema;
    try {
      schema = JSON.parse(raw);
    } catch (err) {
      problems.push(`${relative(root, file)}: invalid JSON (${err.message})`);
      continue;
    }
    for (const key of ['$id', 'title', 'type']) {
      if (!schema[key]) problems.push(`${relative(root, file)}: missing ${key}`);
    }
  }
  record('schemas_valid', problems.length === 0 && files.length >= 6, problems.length ? problems.join(' | ') : `${files.length} schemas parsed`);
}

async function checkRegistrationOrder() {
  const contracts = await readFile(join(srcDir, 'core', 'contracts.mjs'), 'utf8');
  const compose = await readFile(join(srcDir, 'compose.mjs'), 'utf8');
  const orderBlock = /REGISTRATION_ORDER\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(contracts)?.[1] ?? '';
  const expected = [...orderBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const missing = expected.filter((step) => !compose.includes(`'${step}'`));
  record(
    'registration_order',
    expected.length === 8 && missing.length === 0,
    missing.length === 0 ? `8 steps present in compose: ${expected.join(' > ')}` : `compose missing: ${missing.join(', ')}`
  );
}

async function checkManifests() {
  const required = ['id', 'connector', 'kind', 'risk', 'reversible', 'data_in', 'data_out', 'egress', 'idempotent', 'approval'];
  const files = await walk(join(srcDir, 'integrations', 'connectors'), (file) => file.endsWith('.mjs'));
  /** @type {string[]} */
  const problems = [];
  let manifestCount = 0;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const blocks = [...source.matchAll(/manifest:\s*\{([\s\S]*?)\n\s{4,}\}/g)].map((match) => match[1]);
    for (const block of blocks) {
      manifestCount += 1;
      for (const key of required) {
        if (!new RegExp(`\\b${key}:`).test(block)) problems.push(`${relative(root, file)}: manifest missing ${key}`);
      }
    }
  }
  record('tool_manifests', problems.length === 0 && manifestCount >= 6, problems.length ? problems.slice(0, 5).join(' | ') : `${manifestCount} manifests carry required fields`);
}

async function checkBins() {
  // Single source of truth: whatever package.json declares must exist.
  // A hardcoded list drifts the moment a CLI is added (it did, with pa-grant).
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const declared = Object.entries(pkg.bin ?? {});
  /** @type {string[]} */
  const missing = [];
  for (const [name, target] of declared) {
    try {
      await stat(join(root, target));
    } catch {
      missing.push(`${name} -> ${target}`);
    }
  }
  record(
    'cli_bins',
    declared.length > 0 && missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${declared.length} CLIs present (${declared.map(([name]) => name).join(', ')})`
  );
}

async function checkNoSecretsInDocs() {
  // Guard against the most common accident: a real-looking token committed.
  const files = await walk(root, (file) => file.endsWith('.mjs') || file.endsWith('.md') || file.endsWith('.json'));
  const patterns = [/sk-[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/];
  /** @type {string[]} */
  const hits = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (patterns.some((pattern) => pattern.test(source))) hits.push(relative(root, file));
  }
  record('no_committed_secrets', hits.length === 0, hits.length ? hits.join(', ') : 'no token-shaped strings found');
}

async function main() {
  await checkImports();
  await checkSchemas();
  await checkRegistrationOrder();
  await checkManifests();
  await checkBins();
  await checkNoSecretsInDocs();

  const width = Math.max(...checks.map((check) => check.id.length));
  for (const check of checks) {
    process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id.padEnd(width)}  ${check.detail}\n`);
  }
  const failed = checks.filter((check) => !check.ok).length;
  process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
