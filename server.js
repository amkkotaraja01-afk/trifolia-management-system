import express from 'express';
import mysql from 'mysql2/promise';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the project's .env file without requiring dotenv.
// This keeps the system portable after a normal `npm install`.
const envPath = path.join(__dirname, '.env');
try {
  const fs = await import('node:fs');
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  }
} catch (e) {
  console.warn('Could not read .env:', e.message);
}
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', String(process.env.TRUST_PROXY||'').trim()==='1' ? 1 : false);
app.use((req,res,next)=>{
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  if (String(process.env.NODE_ENV||'').toLowerCase()==='production') res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({limit:'12mb', strict:true}));

// In-memory sessions are intentionally short-lived. For multi-instance hosting,
// replace with a shared session store before scaling horizontally.
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const cookieName = 'trifolia_session';
function parseCookies(header='') { return Object.fromEntries(header.split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return i<0?[x,'']:[x.slice(0,i),decodeURIComponent(x.slice(i+1))]})); }
function passwordHash(password, salt=crypto.randomBytes(16).toString('hex')) {
  const derived=crypto.scryptSync(String(password),salt,64).toString('hex');
  return {salt, hash:`scrypt$${salt}$${derived}`};
}
function verifyPassword(password, stored) {
  if (typeof stored!=='string' || !String(password)) return false;
  if (!stored.startsWith('scrypt$')) { const a=Buffer.from(String(password)), b=Buffer.from(String(stored)); return a.length===b.length && crypto.timingSafeEqual(a,b); }
  const [,salt,expected]=stored.split('$');
  if(!salt||!expected) return false;
  const actual=crypto.scryptSync(String(password),salt,64).toString('hex');
  const a=Buffer.from(actual,'hex'), b=Buffer.from(expected,'hex');
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function publicUser(user, viewerRole) { const {password,passwordHash:unused,...safe}=user||{}; delete safe.password_hash; delete safe.passwordHash; if(!isStaff(viewerRole)){delete safe.ic;delete safe.email;} return safe; }
function getSession(req) {
  const token=parseCookies(req.headers.cookie||'')[cookieName];
  const session=token&&sessions.get(token);
  if(!session) return null;
  if(session.expiresAt<Date.now()){sessions.delete(token);return null;}
  session.expiresAt=Date.now()+SESSION_TTL_MS;
  return session;
}
async function requireAuth(req,res,next) {
  const session=getSession(req);
  if(!session) return res.status(401).json({error:'Authentication required.'});
  try {
    const state=await readStoredState();
    const user=(state?.users||[]).find(u=>String(u.id)===String(session.userId));
    if(!user || roleName(user.role)!==roleName(session.role) || user.password!==session.passwordHash) {
      const token=parseCookies(req.headers.cookie||'')[cookieName]; if(token) sessions.delete(token);
      res.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${String(process.env.NODE_ENV||'').toLowerCase()==='production'?'; Secure':''}`);
      return res.status(401).json({error:'Session expired. Please sign in again.'});
    }
    req.auth=session; next();
  } catch { return res.status(503).json({error:'Authentication service temporarily unavailable.'}); }
}
function checkSameOrigin(req,res,next) {
  const origin=req.headers.origin;
  if(origin){ try { const u=new URL(origin); if(u.host!==req.headers.host) return res.status(403).json({error:'Cross-origin request blocked.'}); } catch { return res.status(403).json({error:'Invalid request origin.'}); } }
  next();
}
app.use('/api', (req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)) return checkSameOrigin(req,res,next);
  next();
});


const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'trifolia_management',
  charset: 'utf8mb4'
};

function buildSsl() {
  if (String(process.env.DB_SSL || '').toLowerCase() !== 'true') return undefined;
  const ssl = { rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false' };
  const caPath = process.env.DB_SSL_CA_FILE;
  if (caPath && fs.existsSync(caPath)) ssl.ca = fs.readFileSync(caPath);
  return ssl;
}

const localDataDir = path.join(__dirname, 'data');
const localStatePath = path.join(localDataDir, 'trifolia-state.json');
let storageMode = 'mysql';
let localState = null;

const localSeed = {users:[],applications:[],transactions:[],openingBalances:{},managementPayments:[],penaltyWaivers:[],audit:[],overnightParking:[],overnightLots:Array.from({length:20},(_,i)=>({id:`V-${String(i+1).padStart(2,'0')}`,name:`Visitor Lot V-${String(i+1).padStart(2,'0')}`,active:true})),propertyTenancies:[],propertyOwnerships:[],propertyTransactions:[],maintenanceDefects:[],contractors:[],cashBook:[]};

function cloneSeed(){ return JSON.parse(JSON.stringify(localSeed)); }
function loadLocalState(){
  fs.mkdirSync(localDataDir,{recursive:true});
  try { localState = JSON.parse(fs.readFileSync(localStatePath,'utf8')); }
  catch { localState = cloneSeed(); fs.writeFileSync(localStatePath, JSON.stringify(localState,null,2)); }
  return localState;
}
function saveLocalState(state){
  fs.mkdirSync(localDataDir,{recursive:true});
  const tmp=localStatePath+'.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state,null,2));
  fs.renameSync(tmp,localStatePath);
  localState=state;
}
function localSummary(state){
  const s=state||localState||loadLocalState();
  return {property_tenancies:(s.propertyTenancies||[]).length,property_ownerships:(s.propertyOwnerships||[]).length,property_transactions:(s.propertyTransactions||[]).length,maintenance_defects:(s.maintenanceDefects||[]).length,registered_contractors:(s.contractors||[]).length,cash_book_receipts:(s.cashBook||[]).length,general_ledger_entries:(s.transactions||[]).length,audit_trail:(s.audit||[]).length,visitor_registrations:(s.visitorRegistrations||[]).length,visitor_logs:(s.visitorLogs||[]).length};
}

const pool = mysql.createPool({
  ...dbConfig,
  ssl: buildSsl(),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

async function applySchema(connection) {
  const sqlPath = path.join(__dirname, 'trifolia-schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  // The schema file is safe for repeated startup: CREATE/ALTER statements are
  // idempotent in the shipped schema. Execute as a multi-statement batch.
  await connection.query(sql);
}

async function bootstrapDatabase() {
  const safeDbName = String(dbConfig.database).replace(/[^A-Za-z0-9_$]/g, '');
  if (!safeDbName) throw new Error('Invalid DB_NAME in .env');

  // Preferred production path: the configured database already exists and the
  // application user has access to it. This is how managed MySQL providers work.
  try {
    const conn = await mysql.createConnection({ ...dbConfig, ssl: buildSsl(), multipleStatements: true });
    try {
      await applySchema(conn);
      return;
    } finally {
      await conn.end();
    }
  } catch (existingDbError) {
    if (String(process.env.DB_CREATE_DATABASE || 'false').toLowerCase() === 'false') throw existingDbError;
    // Development/local fallback: connect without a database and create it.
    const admin = await mysql.createConnection({
      host: dbConfig.host, port: dbConfig.port, user: dbConfig.user,
      password: dbConfig.password, ssl: buildSsl(), multipleStatements: true, charset: 'utf8mb4'
    });
    try {
      await admin.query('CREATE DATABASE IF NOT EXISTS `' + safeDbName + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    } finally {
      await admin.end();
    }
    const conn = await mysql.createConnection({ ...dbConfig, ssl: buildSsl(), multipleStatements: true });
    try { await applySchema(conn); } finally { await conn.end(); }
  }
}


app.get('/api/health', async (_req,res)=>{
  if(storageMode==='local') return res.json({ok:true,service:'trifolia'});
  try { await pool.query('SELECT 1'); res.json({ok:true,service:'trifolia'}); }
  catch(e){ res.status(503).json({ok:false,error:'Database unavailable'}); }
});

function sqlDate(value) {
  if (!value) return null;
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
function sqlDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Keep the new modules in real MySQL tables as well as the legacy state bridge.
// The relational tables make reporting, indexing and future integrations safe;
// app_state remains for backward compatibility with the existing screens.
async function syncRelationalModules(conn, state) {
  const rows = Array.isArray;
  const upsert = async (sql, params) => conn.execute(sql, params);

  for (const x of (rows(state.propertyTenancies) ? state.propertyTenancies : [])) {
    await upsert(`INSERT INTO property_tenancies
      (id,unit_no,tenant_name,ic_passport,contact,email,start_date,end_date,monthly_rent,deposit,status,remarks)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE unit_no=VALUES(unit_no),tenant_name=VALUES(tenant_name),ic_passport=VALUES(ic_passport),contact=VALUES(contact),email=VALUES(email),start_date=VALUES(start_date),end_date=VALUES(end_date),monthly_rent=VALUES(monthly_rent),deposit=VALUES(deposit),status=VALUES(status),remarks=VALUES(remarks)`,
      [x.id,x.unit,x.tenantName,x.ic||null,x.contact||null,x.email||null,sqlDate(x.startDate),sqlDate(x.endDate),Number(x.rent||0),Number(x.deposit||0),x.status||'Active',x.remarks||null]);
  }
  for (const x of (rows(state.propertyOwnerships) ? state.propertyOwnerships : [])) {
    await upsert(`INSERT INTO property_ownerships
      (id,unit_no,owner_name,ic_passport,contact,email,ownership_type,share_percent,purchase_date,remarks)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE unit_no=VALUES(unit_no),owner_name=VALUES(owner_name),ic_passport=VALUES(ic_passport),contact=VALUES(contact),email=VALUES(email),ownership_type=VALUES(ownership_type),share_percent=VALUES(share_percent),purchase_date=VALUES(purchase_date),remarks=VALUES(remarks)`,
      [x.id,x.unit,x.ownerName,x.ic||null,x.contact||null,x.email||null,x.ownershipType||'Individual',Number(x.share||100),sqlDate(x.purchaseDate),x.remarks||null]);
  }
  for (const x of (rows(state.propertyTransactions) ? state.propertyTransactions : [])) {
    await upsert(`INSERT INTO property_transactions
      (id,transaction_date,unit_no,transaction_type,reference_no,amount,party,status,remarks,processed_by,processed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE transaction_date=VALUES(transaction_date),unit_no=VALUES(unit_no),transaction_type=VALUES(transaction_type),reference_no=VALUES(reference_no),amount=VALUES(amount),party=VALUES(party),status=VALUES(status),remarks=VALUES(remarks),processed_by=VALUES(processed_by),processed_at=VALUES(processed_at)`,
      [x.id,sqlDate(x.date)||new Date().toISOString().slice(0,10),x.unit,x.transactionType,x.referenceNo||null,Number(x.amount||0),x.party||null,x.status||'Completed',x.remarks||null,x.processedBy||null,sqlDateTime(x.processedAt)]);
  }
  for (const x of (rows(state.maintenanceDefects) ? state.maintenanceDefects : [])) {
    await upsert(`INSERT INTO maintenance_defects
      (id,report_date,unit_no,reported_by,reporter_user_id,contact,category,location,priority,assigned_to,status,description,resolution,resolved_date,remarks,resident_attachments,completion_attachments)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE report_date=VALUES(report_date),unit_no=VALUES(unit_no),reported_by=VALUES(reported_by),reporter_user_id=VALUES(reporter_user_id),contact=VALUES(contact),category=VALUES(category),location=VALUES(location),priority=VALUES(priority),assigned_to=VALUES(assigned_to),status=VALUES(status),description=VALUES(description),resolution=VALUES(resolution),resolved_date=VALUES(resolved_date),remarks=VALUES(remarks),resident_attachments=VALUES(resident_attachments),completion_attachments=VALUES(completion_attachments)`,
      [x.id,sqlDate(x.reportDate)||new Date().toISOString().slice(0,10),x.unit,x.reportedBy,x.reporterUserId||null,x.contact||null,x.category||'Other',x.location||null,x.priority||'Normal',x.assignedTo||null,x.status||'Open',x.description||'',x.resolution||null,sqlDate(x.resolvedDate),x.remarks||null,JSON.stringify(x.beforeAttachments||[]),JSON.stringify(x.afterAttachments||[])]);
  }
  for (const x of (rows(state.contractors) ? state.contractors : [])) {
    await upsert(`INSERT INTO registered_contractors
      (id,company_name,registration_no,contact_person,phone,email,category,expiry_date,status,remarks)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE company_name=VALUES(company_name),registration_no=VALUES(registration_no),contact_person=VALUES(contact_person),phone=VALUES(phone),email=VALUES(email),category=VALUES(category),expiry_date=VALUES(expiry_date),status=VALUES(status),remarks=VALUES(remarks)`,
      [x.id,x.companyName,x.registrationNo||null,x.contactPerson||null,x.phone||null,x.email||null,x.category||null,sqlDate(x.expiryDate),x.status||'Active',x.remarks||null]);
  }
  for (const x of (rows(state.cashBook) ? state.cashBook : [])) {
    await upsert(`INSERT INTO cash_book_receipts
      (id,receipt_no,receipt_date,category,payer,unit_no,amount,payment_method,reference_no,description,remarks,issued_by_id,issued_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE receipt_no=VALUES(receipt_no),receipt_date=VALUES(receipt_date),category=VALUES(category),payer=VALUES(payer),unit_no=VALUES(unit_no),amount=VALUES(amount),payment_method=VALUES(payment_method),reference_no=VALUES(reference_no),description=VALUES(description),remarks=VALUES(remarks),issued_by_id=VALUES(issued_by_id),issued_by_name=VALUES(issued_by_name)`,
      [x.id,x.receiptNo,sqlDate(x.date)||new Date().toISOString().slice(0,10),x.category,x.payer,x.unit||null,Number(x.amount||0),x.method||'Cash',x.referenceNo||null,x.description||null,x.remarks||null,x.issuedBy||'Management',x.issuedByName||x.issuedBy||'Management']);
  }
  for (const x of (rows(state.transactions) ? state.transactions : [])) {
    await upsert(`INSERT INTO general_ledger_entries
      (id,transaction_date,receipt_no,unit_no,direction,transaction_type,description,payment_method,amount,source_id,issued_by_id,issued_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE transaction_date=VALUES(transaction_date),receipt_no=VALUES(receipt_no),unit_no=VALUES(unit_no),direction=VALUES(direction),transaction_type=VALUES(transaction_type),description=VALUES(description),payment_method=VALUES(payment_method),amount=VALUES(amount),source_id=VALUES(source_id),issued_by_id=VALUES(issued_by_id),issued_by_name=VALUES(issued_by_name)`,
      [x.id,sqlDate(x.date)||new Date().toISOString().slice(0,10),x.receiptNo||null,x.unit||null,x.direction,x.type||'MANUAL',x.description||'',x.method||null,Number(x.amount||0),x.cashBookId||x.applicationId||null,x.issuedById||x.issuedBy||null,x.issuedByName||x.issuedBy||null]);
  }
  for (const x of (rows(state.visitorRegistrations) ? state.visitorRegistrations : [])) {
    await upsert(`INSERT INTO visitor_registrations (id,pass_no,resident_id,resident_name,resident_contact,unit_no,visitor_name,visitor_contact,visitor_ic,vehicle_type,car_plate,from_date,to_date,overnight,purpose,remarks,qr_data,qr_data_url,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE resident_id=VALUES(resident_id),resident_name=VALUES(resident_name),resident_contact=VALUES(resident_contact),unit_no=VALUES(unit_no),visitor_name=VALUES(visitor_name),visitor_contact=VALUES(visitor_contact),visitor_ic=VALUES(visitor_ic),vehicle_type=VALUES(vehicle_type),car_plate=VALUES(car_plate),from_date=VALUES(from_date),to_date=VALUES(to_date),overnight=VALUES(overnight),purpose=VALUES(purpose),remarks=VALUES(remarks),qr_data=VALUES(qr_data),qr_data_url=VALUES(qr_data_url),status=VALUES(status),updated_at=VALUES(updated_at)`, [x.id,x.passNo,x.residentId||null,x.residentName||'',x.residentContact||null,x.unit,x.visitorName,x.visitorContact,x.visitorIc||null,x.vehicleType||null,x.carPlate||null,sqlDate(x.fromDate),sqlDate(x.toDate),x.overnight?1:0,x.purpose||null,x.remarks||null,x.qrData||`TRIFOLIA-VISITOR:${x.id}`,x.qrDataUrl||null,x.status||'Active',x.createdBy||null,sqlDateTime(x.createdAt)||new Date().toISOString().slice(0,19).replace('T',' '),sqlDateTime(x.updatedAt)||new Date().toISOString().slice(0,19).replace('T',' ')]);
  }
  for (const x of (rows(state.visitorLogs) ? state.visitorLogs : [])) {
    await upsert(`INSERT INTO visitor_logs (id,registration_id,pass_no,unit_no,resident_name,visitor_name,action,method,at,guard_id,guard_name) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE action=VALUES(action),method=VALUES(method),at=VALUES(at),guard_id=VALUES(guard_id),guard_name=VALUES(guard_name)`, [x.id,x.registrationId,x.passNo,x.unit,x.residentName||null,x.visitorName,x.action,x.method,sqlDateTime(x.at),x.guardId||null,x.guardName||null]);
  }
  // Visitor logs are retained for 90 days only. Purge older rows in MySQL as well as the state bridge.
  await conn.query(`DELETE FROM visitor_logs WHERE at < DATE_SUB(NOW(), INTERVAL 90 DAY)`);

  for (const x of (rows(state.audit) ? state.audit : [])) {
    await upsert(`INSERT INTO audit_trail
      (id,event_time,actor_id,actor_name,action,detail,source_module,source_id)
      VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE event_time=VALUES(event_time),actor_id=VALUES(actor_id),actor_name=VALUES(actor_name),action=VALUES(action),detail=VALUES(detail),source_module=VALUES(source_module),source_id=VALUES(source_id)`,
      [x.id,sqlDateTime(x.at)||new Date().toISOString().slice(0,19).replace('T',' '),x.by||null,x.byName||x.by||null,x.action||'UNKNOWN',x.detail||null,x.module||null,x.sourceId||null]);
  }
}

async function syncV8PreventiveModules(conn, state) {
  const arr = Array.isArray;
  for (const x of (arr(state.technicalDailyJobs)?state.technicalDailyJobs:[])) await conn.execute(`INSERT INTO technical_daily_jobs (id,job_date,job_no,location,job_type,description,assigned_to,status,start_time,end_time,findings,action_taken,remarks,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE job_date=VALUES(job_date),job_no=VALUES(job_no),location=VALUES(location),job_type=VALUES(job_type),description=VALUES(description),assigned_to=VALUES(assigned_to),status=VALUES(status),start_time=VALUES(start_time),end_time=VALUES(end_time),findings=VALUES(findings),action_taken=VALUES(action_taken),remarks=VALUES(remarks),updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`,[x.id,sqlDate(x.date)||new Date().toISOString().slice(0,10),x.jobNo||null,x.location,x.jobType||null,x.description,x.assignedTo||null,x.status||null,x.startTime||null,x.endTime||null,x.findings||null,x.actionTaken||null,x.remarks||null,x.updatedBy||null,sqlDateTime(x.updatedAt)]);
  for (const x of (arr(state.commonAssets)?state.commonAssets:[])) await conn.execute(`INSERT INTO common_area_assets (id,asset_code,asset_name,area,asset_type,asset_condition,last_inspection,next_inspection,responsible,remarks,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE asset_code=VALUES(asset_code),asset_name=VALUES(asset_name),area=VALUES(area),asset_type=VALUES(asset_type),asset_condition=VALUES(asset_condition),last_inspection=VALUES(last_inspection),next_inspection=VALUES(next_inspection),responsible=VALUES(responsible),remarks=VALUES(remarks),updated_at=VALUES(updated_at)`,[x.id,x.assetCode||null,x.assetName,x.area,x.assetType||null,x.condition||null,sqlDate(x.lastInspection),sqlDate(x.nextInspection),x.responsible||null,x.remarks||null,sqlDateTime(x.updatedAt)]);
  for (const x of (arr(state.thirdPartyMaintenance)?state.thirdPartyMaintenance:[])) await conn.execute(`INSERT INTO third_party_maintenance (id,service_date,provider,service_type,reference_no,location,contact,status,next_date,description,findings,remarks,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE service_date=VALUES(service_date),provider=VALUES(provider),service_type=VALUES(service_type),reference_no=VALUES(reference_no),location=VALUES(location),contact=VALUES(contact),status=VALUES(status),next_date=VALUES(next_date),description=VALUES(description),findings=VALUES(findings),remarks=VALUES(remarks),updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`,[x.id,sqlDate(x.serviceDate)||new Date().toISOString().slice(0,10),x.provider,x.serviceType,x.referenceNo||null,x.location||null,x.contact||null,x.status||null,sqlDate(x.nextDate),x.description||null,x.findings||null,x.remarks||null,x.updatedBy||null,sqlDateTime(x.updatedAt)]);
  for (const x of (arr(state.deletedRecords)?state.deletedRecords:[])) await conn.execute(`INSERT INTO deleted_records (id,source_table,record_id,label,deleted_at,permanent_delete_after,deleted_by,deleted_by_name,data_json) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE source_table=VALUES(source_table),record_id=VALUES(record_id),label=VALUES(label),deleted_at=VALUES(deleted_at),permanent_delete_after=VALUES(permanent_delete_after),deleted_by=VALUES(deleted_by),deleted_by_name=VALUES(deleted_by_name),data_json=VALUES(data_json)`,[x.id,x.source||'',x.recordId||'',x.label||null,sqlDateTime(x.deletedAt)||new Date().toISOString().slice(0,19).replace('T',' '),sqlDateTime(x.permanentDeleteAfter)||new Date().toISOString().slice(0,19).replace('T',' '),x.deletedBy||null,x.deletedByName||null,JSON.stringify(x.data||{})]);
}

async function readStoredState() {
  if(storageMode==='local') return loadLocalState();
  const [rows]=await pool.query('SELECT state_json FROM app_state WHERE id=1 LIMIT 1');
  return rows.length ? JSON.parse(rows[0].state_json) : null;
}
function roleName(v){return String(v||'').trim().toLowerCase();}
function isStaff(role){return ['management','office staff'].includes(roleName(role));}
function residentOwnsRow(row,user){
  const units=[user?.unitNo,user?.unit,user?.id].filter(Boolean).map(v=>String(v).toLowerCase());
  const primary=row?.unit??row?.unitNo??row?.unit_no;
  if(primary!=null&&String(primary).trim()) return units.includes(String(primary).toLowerCase());
  return [row?.residentId,row?.resident_id,row?.payerId].some(v=>units.includes(String(v||'').toLowerCase()));
}
function scopeState(state, user){
  const s=JSON.parse(JSON.stringify(state||{}));
  s.users=(s.users||[]).filter(u=>isStaff(user.role)||u.id===user.id||(['guard','security','technical team'].includes(roleName(user.role)) && ['resident','tenant'].includes(roleName(u.role)))).map(u=>publicUser(u,user.role));
  if(isStaff(user.role)) return s;
  const residentKeys=['applications','transactions','managementPayments','accessCards','installmentPlans','overnightParking','overnightLots','visitorRegistrations','maintenanceDefects','securityIncidents','summons','notifications'];
  const guardKeys=['visitorRegistrations','visitorLogs','overnightParking','overnightLots','blacklist','securityIncidents'];
  const techKeys=['maintenanceDefects','contractors','technicalDailyJobs','commonAssets','thirdPartyMaintenance'];
  const allowed=roleName(user.role)==='guard'||roleName(user.role)==='security'?guardKeys:roleName(user.role)==='technical team'?techKeys:residentKeys;
  for(const key of Object.keys(s)) {
    if(key==='users') continue;
    if(!allowed.includes(key)) { if(Array.isArray(s[key])) s[key]=[]; else if(s[key]&&typeof s[key]==='object') s[key]={}; else delete s[key]; continue; }
    if(roleName(user.role)==='resident'||roleName(user.role)==='tenant') {
      if(Array.isArray(s[key])) s[key]=s[key].filter(row=>key==='notifications' ? (row.targetId===user.id || (row.targetRoles||[]).some(r=>roleName(r)===roleName(user.role))) : residentOwnsRow(row,user));
    }
  }
  return s;
}
const WRITE_KEYS={
  'guard':['visitorLogs','securityIncidents','blacklist','overnightParking'],
  'security':['visitorLogs','securityIncidents','blacklist','overnightParking'],
  'technical team':['maintenanceDefects','contractors','technicalDailyJobs','commonAssets','thirdPartyMaintenance'],
  'resident':['applications','managementPayments','accessCards','installmentPlans','overnightParking','visitorRegistrations','maintenanceDefects','notifications'],
  'tenant':['applications','managementPayments','accessCards','installmentPlans','overnightParking','visitorRegistrations','maintenanceDefects','notifications']
};
function mergeScopedState(current, incoming, user){
  if(isStaff(user.role)) return incoming;
  const out=JSON.parse(JSON.stringify(current||{}));
  const role=roleName(user.role), allowed=WRITE_KEYS[role]||[];
  const protectedFields={
    applications:['unit','createdBy','createdByName','source','depositPaid','totalRefunded','totalForfeited','depositReceiptNo','refunds','recordStatus'],
    managementPayments:['unit','unitNo','residentId','residentName','residentIc','residentContact','amount','month','status','approvedByName','approvedAt','receiptNo','penalty','advanceAmount','collectedById','collectedByName'],
    installmentPlans:['unit','residentId','status','approvedByName','approvedAt','terminatedAt','terminationReason','monthlyInstallment','durationMonths','startMonth'],
    accessCards:['unit','residentId','status','approvedBy','approvedAt'],
    visitorRegistrations:['unit','residentId','residentName','createdBy','createdAt','status','passNo'],
    overnightParking:['unit','residentId','createdBy','createdAt','status','amount','fee','paymentStatus'],
    maintenanceDefects:['unit','createdBy','createdAt','status'],
    securityIncidents:['unit','createdBy','createdAt'],
    visitorLogs:['registrationId','passNo','unit','residentName','visitorName','action','at','guardId','guardName'],
    blacklist:['createdBy','createdAt']
  };
  for(const key of allowed){
    if(!Array.isArray(incoming?.[key])) continue;
    const old=Array.isArray(out[key])?out[key]:[];
    const ownedOld=old.filter(x=>role!=='resident'&&role!=='tenant'||residentOwnsRow(x,user));
    const otherRows=old.filter(x=>!ownedOld.includes(x));
    const incomingRows=incoming[key].filter(x=>role!=='resident'&&role!=='tenant'||residentOwnsRow(x,user));
    const oldById=new Map(ownedOld.map(x=>[String(x.id),x]));
    const merged=incomingRows.map(row=>{
      const previous=oldById.get(String(row.id));
      if(!previous){
        const created={...row};
        if(role==='resident'||role==='tenant'){
          const ownUnit=String(user.unitNo||user.unit||user.id);
          if('unit' in created) created.unit=ownUnit;
          if('unitNo' in created) created.unitNo=ownUnit;
          if('unit_no' in created) created.unit_no=ownUnit;
          if('residentId' in created) created.residentId=user.id;
          if('resident_id' in created) created.resident_id=user.id;
          if('payerId' in created) created.payerId=user.id;
          if('createdBy' in created) created.createdBy=user.id;
          if('createdById' in created) created.createdById=user.id;
          if(key==='managementPayments') Object.assign(created,{status:'Pending',approvedByName:'',approvedAt:null,receiptNo:null});
          if(key==='applications') Object.assign(created,{status:'Awaiting Payment Receipt',recordStatus:'Open',depositPaid:0,totalRefunded:0,totalForfeited:0,refunds:[]});
          if(key==='installmentPlans') Object.assign(created,{status:'Pending',approvedByName:'',approvedAt:null,terminatedAt:null,terminationReason:''});
          if(key==='accessCards') Object.assign(created,{status:'Pending',approvedBy:'',approvedAt:null});
          if(key==='overnightParking') Object.assign(created,{status:'Pending',paymentStatus:'Pending'});
          if(key==='visitorRegistrations') created.status='Active';
          if(key==='maintenanceDefects') created.status='Open';
        }
        return created;
      }
      const result={...previous,...row};
      let lockedFields=[...new Set(['unit','unitNo','unit_no','residentId','resident_id','payerId',...(protectedFields[key]||[])])];
      if(role==='guard' && key==='visitorLogs') lockedFields=lockedFields.filter(f=>f!=='action');
      if(role==='technical team' && key==='maintenanceDefects') lockedFields=lockedFields.filter(f=>f!=='status');
      for(const field of lockedFields) if(Object.prototype.hasOwnProperty.call(previous,field)) result[field]=previous[field];
      return result;
    });
    // Non-staff cannot delete existing rows by omitting them from the client payload.
    const incomingIds=new Set(merged.map(x=>String(x.id)));
    const omitted=ownedOld.filter(x=>!incomingIds.has(String(x.id)));
    out[key]=[...otherRows,...merged,...omitted];
  }
  return out;
}

app.post('/api/login', async (req,res)=>{
  const ip=req.ip||req.socket.remoteAddress||'unknown';
  const now=Date.now(); let attempt=loginAttempts.get(ip)||{count:0,until:0};
  if(attempt.until>now) return res.status(429).json({error:'Too many login attempts. Try again later.'});
  const {id,password,role}=req.body||{};
  if(typeof id!=='string'||typeof password!=='string'||typeof role!=='string'||id.length>160||password.length>1024) return res.status(400).json({error:'Enter a valid user ID, password and role.'});
  try {
    const state=await readStoredState();
    const user=(state?.users||[]).find(u=>String(u.id||'').toLowerCase()===id.trim().toLowerCase()&&roleName(u.role)===roleName(role));
    if(!user) {
      attempt.count++; if(attempt.count>=8){attempt.until=now+15*60*1000;attempt.count=0;} loginAttempts.set(ip,attempt);
      return res.status(401).json({error:'Invalid user ID, password or role.'});
    }
    if(String(process.env.NODE_ENV||'').toLowerCase()==='production' && !String(user.password||'').startsWith('scrypt$')) { attempt.count++; if(attempt.count>=8){attempt.until=now+15*60*1000;attempt.count=0;} loginAttempts.set(ip,attempt); return res.status(401).json({error:'Invalid user ID, password or role. Legacy accounts must be reset by the administrator.'}); }
    if(String(process.env.NODE_ENV||'').toLowerCase()==='production' && password.length<16) { attempt.count++; if(attempt.count>=8){attempt.until=now+15*60*1000;attempt.count=0;} loginAttempts.set(ip,attempt); return res.status(401).json({error:'Invalid user ID, password or role.'}); }
    if(!verifyPassword(password,user.password)) {
      attempt.count++; if(attempt.count>=8){attempt.until=now+15*60*1000;attempt.count=0;} loginAttempts.set(ip,attempt);
      return res.status(401).json({error:'Invalid user ID, password or role.'});
    }
    // Upgrade legacy plaintext passwords to scrypt after a successful login.
    if(!String(user.password).startsWith('scrypt$')) {
      user.password=passwordHash(password).hash;
      if(storageMode==='local') saveLocalState(state);
      else await pool.query('UPDATE app_state SET state_json=?,updated_at=NOW(),version=version+1 WHERE id=1',[JSON.stringify(state)]);
    }
    loginAttempts.delete(ip);
    const token=crypto.randomBytes(32).toString('hex');
    sessions.set(token,{userId:user.id,role:user.role,passwordHash:user.password,expiresAt:Date.now()+SESSION_TTL_MS});
    const secure=String(process.env.NODE_ENV||'').toLowerCase()==='production'?'; Secure':'';
    res.setHeader('Set-Cookie',`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}${secure}`);
    res.json({ok:true,user:publicUser(user,user.role)});
  } catch(e){ console.error('Login failed:',e.message); res.status(500).json({error:'Unable to sign in. Please try again.'}); }
});
app.get('/api/session', async (req,res)=>{
  const session=getSession(req); if(!session) return res.status(401).json({authenticated:false});
  try { const state=await readStoredState(); const user=(state?.users||[]).find(u=>u.id===session.userId); if(!user||roleName(user.role)!==roleName(session.role)||user.password!==session.passwordHash){sessions.delete(parseCookies(req.headers.cookie||'')[cookieName]);return res.status(401).json({authenticated:false});} res.json({authenticated:true,user:publicUser(user,user.role)}); }
  catch { res.status(503).json({authenticated:false,error:'Service temporarily unavailable.'}); }
});
app.post('/api/logout', requireAuth, (req,res)=>{
  const token=parseCookies(req.headers.cookie||'')[cookieName]; if(token) sessions.delete(token);
  res.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${String(process.env.NODE_ENV||'').toLowerCase()==='production'?'; Secure':''}`);
  res.json({ok:true});
});
app.post('/api/change-password', requireAuth, async (req,res)=>{
  const password=req.body?.password;
  if(typeof password!=='string'||password.length<16||password.length>1024) return res.status(400).json({error:'Password must be at least 16 characters.'});
  try { const state=await readStoredState(); const user=(state?.users||[]).find(u=>u.id===req.auth.userId); if(!user) return res.status(404).json({error:'User not found.'}); user.password=passwordHash(password).hash;
    if(storageMode==='local') saveLocalState(state); else await pool.query('UPDATE app_state SET state_json=?,updated_at=NOW(),version=version+1 WHERE id=1',[JSON.stringify(state)]);
    req.auth.passwordHash=user.password;
    res.json({ok:true});
  } catch(e){console.error('Password change failed:',e.message);res.status(500).json({error:'Could not change password.'});}
});
app.get('/api/state', requireAuth, async (req,res)=>{
  try { const state=await readStoredState(); if(!state) return res.json({state:null,version:0,updatedAt:null});
    const scoped=scopeState(state,{id:req.auth.userId,role:req.auth.role});
    if(storageMode==='local') return res.json({state:scoped,version:1,updatedAt:new Date().toISOString(),storage:'local-file'});
    const [rows]=await pool.query('SELECT version,updated_at FROM app_state WHERE id=1 LIMIT 1');
    res.json({state:scoped,version:Number(rows[0]?.version||0),updatedAt:rows[0]?.updated_at||null});
  } catch(e){ console.error('State read failed:',e.message); res.status(500).json({error:'Unable to load application data.'}); }
});
app.put('/api/state', requireAuth, async (req,res)=>{
  if(!req.body?.state || typeof req.body.state!=='object' || Array.isArray(req.body.state)) return res.status(400).json({error:'Valid state object is required.'});
  try {
    const current=await readStoredState();
    if(!current) return res.status(503).json({error:'Application state is not initialised. Configure a management account first.'});
    const nextState=mergeScopedState(current,req.body.state,{id:req.auth.userId,role:req.auth.role});
    // Passwords are never returned to the browser. Preserve existing hashes when the UI submits blank fields.
    if(isStaff(req.auth.role) && Array.isArray(nextState.users)) {
      const oldUsers=new Map((current.users||[]).map(u=>[String(u.id).toLowerCase(),u]));
      const selfAccount=nextState.users.find(u=>String(u.id||'').toLowerCase()===String(req.auth.userId).toLowerCase());
      const oldSelf=oldUsers.get(String(req.auth.userId).toLowerCase());
      if(!selfAccount || !oldSelf || roleName(selfAccount.role)!==roleName(oldSelf.role)) return res.status(403).json({error:'You cannot remove or change your own account role.'});
      if(roleName(req.auth.role)==='office staff') {
        for(const oldUser of (current.users||[])) if(roleName(oldUser.role)==='management') {
          const incomingUser=nextState.users.find(u=>String(u.id||'').toLowerCase()===String(oldUser.id).toLowerCase());
          if(!incomingUser || roleName(incomingUser.role)!=='management') return res.status(403).json({error:'Office Staff cannot remove or change a Management account.'});
        }
        if(nextState.users.some(u=>roleName(u.role)==='management'&&roleName(oldUsers.get(String(u.id||'').toLowerCase())?.role)!=='management')) return res.status(403).json({error:'Office Staff cannot create or promote accounts to Management.'});
        nextState.users=nextState.users.map(u=>roleName(oldUsers.get(String(u.id||'').toLowerCase())?.role)==='management' ? oldUsers.get(String(u.id||'').toLowerCase()) : u);
      }
      if(nextState.users.some(u=>u.password && !String(u.password).startsWith('scrypt$') && String(u.password).length<16)) return res.status(400).json({error:'Passwords must be at least 16 characters.'});
      if(nextState.users.some(u=>!oldUsers.has(String(u.id||'').toLowerCase()) && (!u.password || String(u.password).length<16))) return res.status(400).json({error:'New accounts require a password of at least 16 characters.'});
      nextState.users=nextState.users.map(u=>{ const old=oldUsers.get(String(u.id||'').toLowerCase()); if(!u.password && old) return {...u,password:old.password}; if(u.password && !String(u.password).startsWith('scrypt$')) return {...u,password:passwordHash(u.password).hash}; return u; });
      const validRoles=new Set(['management','office staff','guard','security','technical team','resident','tenant']);
      if(nextState.users.some(u=>!validRoles.has(roleName(u.role)))) return res.status(400).json({error:'Invalid user role.'});
    }
    if(storageMode==='local'){ saveLocalState(nextState); return res.json({ok:true,version:1,storage:'local-file'}); }
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [currentRows]=await conn.query('SELECT version FROM app_state WHERE id=1 FOR UPDATE');
      const currentVersion=Number(currentRows[0]?.version||0);
      const expected=req.body.expectedVersion==null?null:Number(req.body.expectedVersion);
      if(expected!=null&&expected!==currentVersion){await conn.rollback();return res.status(409).json({error:'Database changed by another user.',version:currentVersion,conflict:true});}
      const json=JSON.stringify(nextState); const version=currentVersion+1;
      await conn.query(`INSERT INTO app_state (id,state_json,version,updated_at) VALUES (1,?,?,NOW()) ON DUPLICATE KEY UPDATE state_json=VALUES(state_json),version=VALUES(version),updated_at=NOW()`,[json,version]);
      if(isStaff(req.auth.role)) await syncRelationalModules(conn,nextState);
      await conn.commit(); res.json({ok:true,version});
    } catch(e){try{await conn.rollback()}catch{};console.error('Shared state save failed:',e.message);res.status(500).json({error:'Could not save application data.'});}
    finally {conn.release();}
  } catch(e){console.error('State update failed:',e.message);res.status(500).json({error:'Could not update application data.'});}
});

app.get('/api/database-summary', requireAuth, async (req,res)=>{
  if(!isStaff(req.auth.role)) return res.status(403).json({error:'Insufficient permissions.'});
  try {
    if(storageMode==='local') return res.json({ok:true,storage:'local-file',tables:localSummary()});
    const names=['property_tenancies','property_ownerships','property_transactions','maintenance_defects','registered_contractors','cash_book_receipts','general_ledger_entries','audit_trail','visitor_registrations','visitor_logs'];
    const out={};
    for(const n of names){const [r]=await pool.query(`SELECT COUNT(*) count FROM \`${n}\``);out[n]=Number(r[0].count);}
    res.json({ok:true,storage:'mysql',tables:out});
  } catch(e){console.error('Database summary failed:',e.message);res.status(500).json({ok:false,error:'Unable to load database summary.'});}
});

// Do not let unknown API paths fall through to the SPA.
app.use('/api', (_req,res)=>res.status(404).json({error:'API endpoint not found.'}));

// Serve the production React build so phones/tablets use the same origin and database.
app.use(express.static(path.join(__dirname,'dist')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'dist','index.html')));

const port=Number(process.env.PORT||3001);
const server = app.listen(port,'0.0.0.0', async ()=>{
  console.log(`Trifolia server listening on port ${port}`);
  const forcedLocal=String(process.env.STORAGE_MODE||'auto').toLowerCase()==='local';
  if(forcedLocal && String(process.env.NODE_ENV||'').toLowerCase()==='production'){console.error('FATAL: STORAGE_MODE=local is not permitted in production.');process.exit(1);return;}
  if(forcedLocal){ storageMode='local'; loadLocalState(); if(!(localState.users||[]).length && process.env.BOOTSTRAP_ADMIN_USER && process.env.BOOTSTRAP_ADMIN_PASSWORD){if(String(process.env.BOOTSTRAP_ADMIN_PASSWORD).length<16)throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 16 characters.');localState.users=[{id:String(process.env.BOOTSTRAP_ADMIN_USER).trim(),password:passwordHash(process.env.BOOTSTRAP_ADMIN_PASSWORD).hash,role:'Management',name:'System Administrator',contact:''}];saveLocalState(localState);} console.log(`Local storage enabled: ${localStatePath}`); return; }
  try {
    if(String(process.env.NODE_ENV||'').toLowerCase()==='production' && (!dbConfig.password || dbConfig.user.toLowerCase()==='root')) throw new Error('Production requires a dedicated non-root database user and non-empty DB_PASSWORD.');
    await bootstrapDatabase();
    await pool.query('SELECT 1');
    storageMode='mysql';
    // A fresh production database is initialised only from an explicit bootstrap secret.
    const [stateRows]=await pool.query('SELECT id FROM app_state WHERE id=1 LIMIT 1');
    if(!stateRows.length && process.env.BOOTSTRAP_ADMIN_USER && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
      if(String(process.env.BOOTSTRAP_ADMIN_PASSWORD).length<16) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 16 characters.');
      const initial=cloneSeed();
      initial.users=[{id:String(process.env.BOOTSTRAP_ADMIN_USER).trim(),password:passwordHash(process.env.BOOTSTRAP_ADMIN_PASSWORD).hash,role:'Management',name:'System Administrator',contact:''}];
      await pool.query('INSERT INTO app_state (id,state_json,version,updated_at) VALUES (1,?,1,NOW())',[JSON.stringify(initial)]);
      console.log('Initial management account created from bootstrap environment variables.');
    } else if(!stateRows.length) {
      throw new Error('No application state found. Set BOOTSTRAP_ADMIN_USER and BOOTSTRAP_ADMIN_PASSWORD to initialise the first management account.');
    }
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD; delete process.env.BOOTSTRAP_ADMIN_USER;
    console.log(`MySQL connected: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    console.log('Trifolia database schema is ready.');
  } catch (e) {
    const production=String(process.env.NODE_ENV||'').toLowerCase()==='production';
    const mysqlOnly=String(process.env.STORAGE_MODE||'auto').toLowerCase()==='mysql';
    if(production || mysqlOnly){
      console.error('FATAL: MySQL connection/setup failed:', e.message);
      console.error(`Target: ${dbConfig.host}:${dbConfig.port}, user: ${dbConfig.user}, database: ${dbConfig.database}`);
      process.exit(1);
    }
    storageMode='local';
    loadLocalState();
    console.warn('MySQL is not available. Trifolia is starting in LOCAL MODE instead.');
    console.warn(`Local data file: ${localStatePath}`);
    console.warn('For online hosting, set NODE_ENV=production and valid DB_* variables.');
  }
});

const shutdown = async () => {
  try { server.close(); } catch {}
  try { await pool.end(); } catch {}
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);
