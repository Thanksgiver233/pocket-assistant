/**
 * A very small JSON Schema validator (draft 2020-12 subset).
 *
 * Why not ajv: P0 must run with zero installs in an environment where the
 * package manager and the shell are unavailable. The subset below is exactly
 * what our own schemas use; anything outside it throws instead of silently
 * passing, so a schema can never be "validated" by accident.
 *
 * Supported: type (incl. arrays of types, 'integer'), enum, const, required,
 * properties, additionalProperties (boolean), items, minItems, maxItems,
 * uniqueItems, pattern, minLength, maxLength, minimum, maximum, oneOf,
 * anyOf, allOf, format ('date-time' only), $ref to local '#/$defs/*'.
 *
 * @module @piagent/personal/core/schema
 */

import { ValidationError } from './errors.mjs';

const SUPPORTED_KEYS = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'title',
  'description',
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'oneOf',
  'anyOf',
  'allOf',
  'format',
  'default',
  'examples',
  'deprecated',
  'readOnly'
]);

/**
 * Validate `value` against `schema`. Throws ValidationError with a JSON-path
 * style location on the first failure.
 * @param {Object} schema
 * @param {unknown} value
 * @param {{path?: string, root?: Object}} [ctx]
 */
export function validate(schema, value, ctx = {}) {
  const path = ctx.path ?? '$';
  const root = ctx.root ?? schema;

  if (schema === null || typeof schema !== 'object') {
    throw new ValidationError(`invalid schema at ${path}: expected object`, { path });
  }
  assertSchemaIsSupported(schema, path);

  if (schema.$ref) {
    const target = resolveRef(root, schema.$ref, path);
    validate(target, value, { path, root });
    return;
  }

  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    throw new ValidationError(`${path}: expected const ${JSON.stringify(schema.const)}`, { path });
  }
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    throw new ValidationError(`${path}: expected one of ${JSON.stringify(schema.enum)}`, { path });
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      throw new ValidationError(`${path}: expected type ${types.join('|')}, got ${describeType(value)}`, { path });
    }
  }

  if (typeof value === 'string') validateString(schema, value, path);
  if (typeof value === 'number') validateNumber(schema, value, path);
  if (Array.isArray(value)) validateArray(schema, value, path, root);
  if (isPlainObject(value)) validateObject(schema, value, path, root);

  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) {
      const hits = schema[key].filter((sub) => {
        try {
          validate(sub, value, { path, root });
          return true;
        } catch {
          return false;
        }
      });
      if (key === 'oneOf' && hits.length !== 1) {
        throw new ValidationError(`${path}: expected exactly one oneOf branch to match, matched ${hits.length}`, { path });
      }
      if (key === 'anyOf' && hits.length === 0) {
        throw new ValidationError(`${path}: no anyOf branch matched`, { path });
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validate(sub, value, { path, root });
  }
}

/** @param {Object} schema @param {string} path */
function assertSchemaIsSupported(schema, path) {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYS.has(key)) {
      throw new ValidationError(
        `schema at ${path} uses unsupported keyword "${key}"; refusing to validate (fail-closed)`,
        { path }
      );
    }
  }
}

/**
 * @param {Object} root
 * @param {string} ref
 * @param {string} path
 */
function resolveRef(root, ref, path) {
  if (!ref.startsWith('#/')) {
    throw new ValidationError(`${path}: only local $ref is supported, got ${ref}`, { path });
  }
  let node = root;
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in node)) {
      throw new ValidationError(`${path}: unresolved $ref ${ref}`, { path });
    }
    node = node[key];
  }
  return node;
}

/** @param {string} type @param {unknown} value */
function matchesType(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      throw new ValidationError(`unknown schema type "${type}"`, {});
  }
}

/** @param {unknown} value */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {Object} schema @param {string} value @param {string} path */
function validateString(schema, value, path) {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new ValidationError(`${path}: shorter than minLength ${schema.minLength}`, { path });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new ValidationError(`${path}: longer than maxLength ${schema.maxLength}`, { path });
  }
  if (schema.pattern !== undefined) {
    // Patterns come from our own schemas; a bad pattern is a programming error.
    const re = new RegExp(schema.pattern);
    if (!re.test(value)) {
      throw new ValidationError(`${path}: does not match pattern ${schema.pattern}`, { path });
    }
  }
  if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${path}: expected date-time, got ${value}`, { path });
  }
}

/** @param {Object} schema @param {number} value @param {string} path */
function validateNumber(schema, value, path) {
  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new ValidationError(`${path}: below minimum ${schema.minimum}`, { path });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    throw new ValidationError(`${path}: above maximum ${schema.maximum}`, { path });
  }
}

/** @param {Object} schema @param {unknown[]} value @param {string} path @param {Object} root */
function validateArray(schema, value, path, root) {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new ValidationError(`${path}: fewer than minItems ${schema.minItems}`, { path });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new ValidationError(`${path}: more than maxItems ${schema.maxItems}`, { path });
  }
  if (schema.uniqueItems) {
    const seen = new Set();
    for (const item of value) {
      const key = JSON.stringify(item);
      if (seen.has(key)) throw new ValidationError(`${path}: duplicate item ${key}`, { path });
      seen.add(key);
    }
  }
  if (schema.items) {
    value.forEach((item, index) => validate(schema.items, item, { path: `${path}[${index}]`, root }));
  }
}

/** @param {Object} schema @param {Record<string, unknown>} value @param {string} path @param {Object} root */
function validateObject(schema, value, path, root) {
  for (const key of schema.required ?? []) {
    if (!(key in value)) throw new ValidationError(`${path}: missing required property "${key}"`, { path });
  }
  const properties = schema.properties ?? {};
  for (const [key, sub] of Object.entries(properties)) {
    if (key in value) validate(sub, value[key], { path: `${path}.${key}`, root });
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        throw new ValidationError(`${path}: unexpected property "${key}"`, { path });
      }
    }
  } else if (isPlainObject(schema.additionalProperties)) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        validate(schema.additionalProperties, value[key], { path: `${path}.${key}`, root });
      }
    }
  }
}

/** @param {unknown} a @param {unknown} b */
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Convenience: validate and return the value, so callers can inline it.
 * @template T
 * @param {Object} schema
 * @param {T} value
 * @returns {T}
 */
export function check(schema, value) {
  validate(schema, value);
  return value;
}
