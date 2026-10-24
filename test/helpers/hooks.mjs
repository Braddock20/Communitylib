import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const stubs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'stubs');
const MAP = { 'aws4fetch': 'aws4fetch.mjs', '@neondatabase/serverless': 'neon.mjs' };
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && MAP[specifier]) return { url: pathToFileURL(path.join(stubs, MAP[specifier])).href, shortCircuit: true };
    throw e;
  }
}
