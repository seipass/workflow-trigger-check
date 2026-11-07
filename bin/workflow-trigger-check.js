#!/usr/bin/env node
import { main } from '../cli/cli.js';

process.exitCode = main(process.argv.slice(2));
