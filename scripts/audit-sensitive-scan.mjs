import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDatabasePath } from '../db/index.ts';

const sensitiveKeys=new Set([
  'phone','memo','note','comment','score','pre_score','post_score',
  'not_completed_reason','status_reason','pin','pin_hash','password',
  'session_secret','cookie','authorization','token','secret','title','reason',
]);
const freeTextSummaryEntities=new Set(['참가자','일정']);

function containsSensitiveKey(value){
  if(Array.isArray(value))return value.some(containsSensitiveKey);
  if(!value||typeof value!=='object')return false;
  return Object.entries(value).some(([key,item])=>sensitiveKeys.has(key.toLowerCase())||containsSensitiveKey(item));
}

function parsesToSensitivePayload(raw){
  if(!raw)return false;
  try{return containsSensitiveKey(JSON.parse(raw));}catch{return false;}
}

const databaseArgumentIndex=process.argv.indexOf('--database');
const databasePath=databaseArgumentIndex>=0?process.argv[databaseArgumentIndex+1]:getDatabasePath();
if(!databasePath||!path.isAbsolute(databasePath))throw new Error('진단할 DB의 절대경로를 --database 인수 또는 현재 환경의 DB 경로로 지정하세요.');
if(!existsSync(databasePath))throw new Error('진단할 DB 파일이 존재하지 않습니다.');
const db=new DatabaseSync(databasePath,{readOnly:true});
const rows=db.prepare('SELECT action,entity_type,before_json,after_json,summary,reason FROM audit_logs').all();
const groups=new Map();
for(const row of rows){
  const riskySummary=Boolean(row.summary)&&freeTextSummaryEntities.has(row.entity_type);
  if(!parsesToSensitivePayload(row.before_json)&&!parsesToSensitivePayload(row.after_json)&&!riskySummary&&!row.reason)continue;
  const key=`${row.action}\u0000${row.entity_type}`;
  groups.set(key,(groups.get(key)||0)+1);
}

const result=[...groups.entries()].map(([key,count])=>{
  const [action,entity_type]=key.split('\u0000');
  return {action,entity_type,count};
}).sort((a,b)=>b.count-a.count||a.entity_type.localeCompare(b.entity_type));

console.log(JSON.stringify({total_rows:rows.length,suspected_rows:result.reduce((sum,item)=>sum+item.count,0),groups:result,interpretation:'heuristic_candidates_not_proof_of_absence'},null,2));
db.close();
