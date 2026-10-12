import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { LocalDatabase } from '../lib/runtime/local-sqlite.ts';
test('local SQLite persists across processes without Cloudflare and batch rollback protects leases',async()=>{
 const dir=mkdtempSync(tmpdir()+'/qquan-sqlite-');process.env.QQUAN_DATA_DIR=dir;
 const a=new LocalDatabase();await a.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY, owner TEXT)');
 await a.prepare('INSERT INTO jobs VALUES (?,?)').bind('one','first').run();
 const b=new LocalDatabase();assert.equal((await b.prepare('SELECT owner FROM jobs').first('owner')),'first');
 await assert.rejects(a.batch([a.prepare("UPDATE jobs SET owner='bad'"),a.prepare("INSERT INTO jobs VALUES ('one','duplicate')")]));
 assert.equal(await b.prepare('SELECT owner FROM jobs').first('owner'),'first');
 const claim=await b.prepare("UPDATE jobs SET owner=? WHERE owner=? RETURNING id").bind('next','first').all();assert.equal(claim.meta.changes,1);
 const script=`import {LocalDatabase} from ${JSON.stringify(new URL('../lib/runtime/local-sqlite.ts',import.meta.url).href)};console.log(await new LocalDatabase().prepare('SELECT owner FROM jobs').first('owner'))`;
 const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('CLOUDFLARE_'))delete env[k];
 const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/next/);
 a.db.close();b.db.close();rmSync(dir,{recursive:true,force:true});delete process.env.QQUAN_DATA_DIR;
});
