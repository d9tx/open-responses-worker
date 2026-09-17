import { bad, object, type Obj } from './runtime';

const allowed = ['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'anyOf', 'enum', 'description', 'title'];
const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

// Deliberately bounded subset: unknown validation keywords are rejected, never ignored.
export function checkSchema(raw: unknown, depth = 0): Obj {
  if (depth > 24) bad('Schema nesting exceeds 24 levels.');
  const s = object(raw);
  for (const key of Object.keys(s)) if (!allowed.includes(key)) bad(`Unsupported schema keyword: ${key}`);
  for (const key of ['description', 'title']) if (s[key] !== undefined && typeof s[key] !== 'string') bad('Invalid schema annotation.');
  const declared = s.type === undefined ? types : Array.isArray(s.type) ? s.type : [s.type];
  if (!declared.length || declared.some(t => typeof t !== 'string' || !types.includes(t))) bad('Schema requires a supported type.');
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length || s.enum.some(v => v !== null && typeof v === 'object'))) bad('Only nonempty scalar enums are supported.');
  if (s.properties !== undefined) {
    if (!declared.includes('object')) bad('properties requires object type.');
    for (const child of Object.values(object(s.properties))) checkSchema(child, depth + 1);
  }
  if (s.required !== undefined && (!declared.includes('object') || !Array.isArray(s.required) || s.required.some(v => typeof v !== 'string'))) bad('Invalid required list.');
  if (s.additionalProperties !== undefined) {
    if (!declared.includes('object')) bad('additionalProperties requires object type.');
    if (typeof s.additionalProperties !== 'boolean') checkSchema(s.additionalProperties, depth + 1);
  }
  if (s.items !== undefined) {
    if (!declared.includes('array')) bad('items requires array type.');
    checkSchema(s.items, depth + 1);
  }
  for (const key of ['minItems', 'maxItems']) {
    if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isSafeInteger(s[key]) || s[key] < 0)) bad(`${key} must be a nonnegative integer.`);
  }
  if (s.anyOf !== undefined) {
    if (!Array.isArray(s.anyOf) || !s.anyOf.length) bad('anyOf must be a nonempty array of schemas.');
    for (const branch of s.anyOf) checkSchema(branch, depth + 1);
  }
  return s;
}
export function matches(value: unknown, s: Obj, depth = 0): boolean {
  if (depth > 64 || typeof value === 'number' && !Number.isFinite(value)) return false;
  if (Array.isArray(s.anyOf) && !s.anyOf.some(branch => matches(value, object(branch), depth + 1))) return false;
  const declared = s.type === undefined ? types : Array.isArray(s.type) ? s.type : [s.type];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!declared.includes(kind) && !(kind === 'number' && Number.isInteger(value) && declared.includes('integer'))) return false;
  if (Array.isArray(s.enum) && !s.enum.includes(value)) return false;
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems || typeof s.maxItems === 'number' && value.length > s.maxItems) return false;
    return s.items === undefined || value.every(v => matches(v, object(s.items), depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const v = object(value);
    const props = s.properties === undefined ? {} : object(s.properties);
    if (Array.isArray(s.required) && s.required.some(k => typeof k !== 'string' || !Object.hasOwn(v, k))) return false;
    for (const [k, child] of Object.entries(v)) {
      if (Object.hasOwn(props, k)) { if (!matches(child, object(props[k]), depth + 1)) return false; }
      else if (s.additionalProperties === false) return false;
      else if (s.additionalProperties !== undefined && s.additionalProperties !== true && !matches(child, object(s.additionalProperties), depth + 1)) return false;
    }
  }
  return true;
}
