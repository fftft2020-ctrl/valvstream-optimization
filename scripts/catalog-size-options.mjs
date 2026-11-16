// Use the same parser as both capacity query entry points, including in portable packages.
import { existsSync } from 'node:fs';
const skill = new URL('../', import.meta.url);
const engine = existsSync(new URL('runtime/pre-sizing.mjs', skill)) ? 'runtime/pre-sizing.mjs' : '../../../tools/valvstream/pre-sizing.mjs';
const { catalogSizeOptions } = await import(new URL(engine, skill));
export { catalogSizeOptions };
