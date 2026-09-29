// Lets Node's built-in TypeScript support load the Worker sources, which use
// extensionless relative imports resolved by Wrangler's bundler.
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
