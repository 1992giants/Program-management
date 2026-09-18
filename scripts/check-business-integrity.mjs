import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDatabasePath } from '../db/index.ts';

const argumentIndex=process.argv.indexOf('--database');
const databasePath=argumentIndex>=0?process.argv[argumentIndex+1]:getDatabasePath();
if(!databasePath||!path.isAbsolute(databasePath))throw new Error('진단할 DB의 절대경로를 --database 인수 또는 현재 환경의 DB 경로로 지정하세요.');
if(!existsSync(databasePath))throw new Error('진단할 DB 파일이 존재하지 않습니다.');

const db=new DatabaseSync(databasePath,{readOnly:true});
const auditActions=applicationId=>db.prepare("SELECT action FROM audit_logs WHERE entity_type='신청' AND entity_id=? ORDER BY id DESC LIMIT 5").all(String(applicationId)).map(row=>row.action);
const withAudit=rows=>rows.map(row=>({...row,audit_actions:auditActions(row.application_id)}));
const attendanceRunMismatch=withAudit(db.prepare(`
  SELECT at.id AS attendance_id,at.application_id,a.participant_id,a.program_id,a.run_id AS application_run_id,
         at.session_id,s.run_id AS session_run_id,s.session_date,at.status AS attendance_status
  FROM attendance at
  JOIN applications a ON a.id=at.application_id
  JOIN sessions s ON s.id=at.session_id
  WHERE a.run_id IS NOT s.run_id
  ORDER BY at.id
`).all());
const applicationRunProgramMismatch=db.prepare(`
  SELECT a.id AS application_id,a.participant_id,a.program_id AS application_program_id,a.run_id,r.program_id AS run_program_id
  FROM applications a JOIN program_runs r ON r.id=a.run_id
  WHERE a.program_id<>r.program_id
  ORDER BY a.id
`).all();
const makeupRunMismatch=withAudit(db.prepare(`
  SELECT at.id AS attendance_id,at.application_id,a.participant_id,at.session_id,s.run_id AS session_run_id,
         at.makeup_for_session_id,ms.run_id AS makeup_session_run_id
  FROM attendance at
  JOIN applications a ON a.id=at.application_id
  JOIN sessions s ON s.id=at.session_id
  LEFT JOIN sessions ms ON ms.id=at.makeup_for_session_id
  WHERE at.makeup_for_session_id IS NOT NULL AND (ms.id IS NULL OR s.run_id IS NOT ms.run_id)
  ORDER BY at.id
`).all());
db.close();
console.log(JSON.stringify({
  read_only:true,
  database:path.basename(databasePath),
  repair:'not_performed',
  issue_counts:{attendance_run_mismatch:attendanceRunMismatch.length,application_run_program_mismatch:applicationRunProgramMismatch.length,makeup_run_mismatch:makeupRunMismatch.length},
  issues:{attendance_run_mismatch:attendanceRunMismatch,application_run_program_mismatch:applicationRunProgramMismatch,makeup_run_mismatch:makeupRunMismatch},
},null,2));
