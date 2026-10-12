import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath=path.join(root,'.env');
if(fs.existsSync(envPath)) for(const raw of fs.readFileSync(envPath,'utf8').split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#'))continue;const i=line.indexOf('=');if(i<1)continue;const k=line.slice(0,i).trim();let v=line.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}
const userId=process.argv[2];
if(!userId){console.error('Usage: node scripts/reset-user-password.mjs <USER_ID>');process.exit(2);}
const rl=readline.createInterface({input,output});
try{
 const p1=await rl.question('New password (minimum 16 characters): ');
 const p2=await rl.question('Repeat new password: ');
 if(p1.length<16||p1!==p2) throw new Error('Passwords must match and be at least 16 characters.');
 const salt=crypto.randomBytes(16).toString('hex');
 const hash=crypto.scryptSync(p1,salt,64).toString('hex');
 const db=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME||'trifolia_management',charset:'utf8mb4',ssl:String(process.env.DB_SSL||'').toLowerCase()==='true'?{rejectUnauthorized:String(process.env.DB_SSL_REJECT_UNAUTHORIZED||'true').toLowerCase()!=='false'}:undefined});
 try{
  const [rows]=await db.query('SELECT state_json FROM app_state WHERE id=1 LIMIT 1');
  if(!rows.length) throw new Error('app_state row is missing. Initialise the database first.');
  const state=JSON.parse(rows[0].state_json); const u=(state.users||[]).find(x=>String(x.id||'').toLowerCase()===userId.toLowerCase());
  if(!u) throw new Error(`User ${userId} was not found in app_state.`);
  u.password=`scrypt$${salt}$${hash}`;
  await db.query('UPDATE app_state SET state_json=?,version=version+1,updated_at=NOW() WHERE id=1',[JSON.stringify(state)]);
  console.log(`Password reset completed for ${u.id}.`);
 }finally{await db.end();}
}catch(e){console.error(`Password reset failed: ${e.message}`);process.exitCode=1;}finally{rl.close();}
