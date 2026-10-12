/** Compatibility entrypoint: shared NVDA one-minute Parquet downloader. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
try { loadEnvFile('.dev.vars'); } catch {}
const child=spawn(process.env.QQUAN_PYTHON||resolve('.venv/bin/python'),[resolve('scripts/data/download-stock-minute.py'),...process.argv.slice(2)],{stdio:'inherit',env:process.env});
child.on('exit',code=>process.exitCode=code??1);
