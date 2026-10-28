#!/usr/bin/env node

// coord-engine 独立入口：在被 consuming 项目以 submodule 挂载时，项目侧的
// scripts/coordination.mjs 薄 shim 会转发到本引擎（I-249）。

import { main } from '../lib/coordination/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
