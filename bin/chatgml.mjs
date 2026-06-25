#!/usr/bin/env node
// bin/chatgml.mjs — thin shebang shim that invokes the built CLI main() and sets the exit code.
import { main } from '../dist/cli.js';

const code = await main(process.argv.slice(2));
process.exitCode = code;
