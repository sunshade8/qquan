import { readFileSync, existsSync } from 'node:fs';
const parseEnv = text => Object.fromEntries(text.split(/\r?\n/)
  .map(line => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/))
  .filter(Boolean).map(([, key, raw]) => [key, raw.replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2')]));
import { execFileSync } from 'node:child_process';

// Values stay in memory and stdin; never put credentials in command arguments.
const apply = process.argv.includes('--apply');
const environments = ['production', 'preview', 'development'];
const link = JSON.parse(readFileSync('.vercel/project.json', 'utf8'));
if (link.projectName !== 'qquan') throw new Error('Link this checkout to the qquan Vercel project first.');
const defaults = parseEnv(readFileSync('.env.example', 'utf8'));
const sharedFiles = ['.dev.vars', '.env', '.env.local'];
const payload = [];
for (const target of environments) {
  const localFiles = [...sharedFiles, `.env.${target}`, `.env.${target}.local`];
  const values = { ...defaults };
  for (const file of localFiles) {
    if (existsSync(file)) Object.assign(values, parseEnv(readFileSync(file, 'utf8')));
  }
  for (const [key, value] of Object.entries(values)) {
    if (!value || /^(VERCEL_|NODE_ENV$)/.test(key)) continue;
    payload.push({ key, value, type: 'encrypted', target: [target] });
  }
  console.log(`${target}: ${payload.filter(item => item.target[0] === target).map(item => item.key).join(', ')}`);
}
if (!apply) {
  console.log('Dry run. Add --apply to upload the listed variables. Values are never printed.');
} else {
  for (const entry of payload) {
  const response = execFileSync('vercel', ['api', `/v10/projects/${link.projectId}/env?teamId=${link.orgId}&upsert=true`, '-X', 'POST', '--input', '-', '--raw'], {
    input: JSON.stringify(entry), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = JSON.parse(response);
  if (result.error || result.failed?.length) throw new Error('Vercel rejected some variables; inspect environment settings.');
  }
  console.log(`Uploaded ${payload.length} environment entries to qquan.`);
}
