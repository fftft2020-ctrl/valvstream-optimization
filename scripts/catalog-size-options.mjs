// Use the same parser as both capacity query entry points, including in portable packages.
import { existsSync } from 'node:fs';
const skill = new URL('../', import.meta.url);
const runtime = existsSync(new URL('runtime', skill)) ? 'runtime/' : '../../../';
const { catalogSizeOptions } = await import(new URL(runtime + 'tools/valvstream/pre-sizing.mjs', skill));
export { catalogSizeOptions };
