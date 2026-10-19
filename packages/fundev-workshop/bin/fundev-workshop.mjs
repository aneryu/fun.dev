#!/usr/bin/env node
// The fun.dev workshop: --run model.mjs, --guide, --mcp (README.md).
import { main } from "../workshop.mjs";
await main(process.argv.slice(2));
