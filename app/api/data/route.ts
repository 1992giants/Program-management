import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRun, getBackupDirectory, getDatabase, getDatabasePath, getStorageInfo, hashPin, verifyPin } from '../../../db/index.ts';
import { attendanceOnlySnapshot, canPerformAction, createAuthSession, expiredSessionCookie, getAuthenticatedUser, invalidateAuthSession, sessionCookie, validateMutationRequest, type SafeUser } from '../../../lib/security.ts';
import { inclusiveCalendarDays, isCanonicalCalendarDate } from '../../../lib/schedule-state.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

class ActionError extends Error {}

function noStore(response:Response) { response.headers.set('Cache-Control','no-store');return response; }
function clearSessionCookie(response:Response) { response.headers.append('Set-Cookie',expiredSessionCookie());return response; }
function loginRequired(message='로그인이 필요합니다.') { return clearSessionCookie(Response.json({error:message,loginRequired:true},{status:401})); }
function internalError(error:unknown) { console.error('[api/data] internal error',error);return Response.json({error:'internal_server_error'},{status:500}); }

function rows(sql:string, ...params:SQLInputValue[]) { return getDatabase().prepare(sql).all(...params); }
const text = (value:unknown) => String(value ?? '');
type OutcomeScope={programId:string;runId:string|null};
type AttendanceScope={sessionId:string;runId:string;programId:string;attendanceStatus:string};
type AttendanceApplication={id:number;run_id:string|null;program_id:string;status:string};
function canonicalAttendanceScope(db:DatabaseSync,sessionId:string):AttendanceScope {
  const scope=db.prepare('SELECT s.id AS session_id,s.run_id,s.attendance_status,r.program_id FROM sessions s JOIN program_runs r ON r.id=s.run_id WHERE s.id=?').get(sessionId) as {session_id:string;run_id:string;attendance_status:string;program_id:string}|undefined;
  if(!scope)throw new ActionError('회기를 찾을 수 없습니다.');
  return {sessionId:scope.session_id,runId:scope.run_id,programId:scope.program_id,attendanceStatus:scope.attendance_status};
}
function attendanceApplicationMatchesScope(application:AttendanceApplication,scope:AttendanceScope) {
  return application.run_id===scope.runId&&application.program_id===scope.programId;
}
function canonicalOutcomeScope(db:DatabaseSync,programValue:unknown,runSupplied:boolean,runValue?:unknown):OutcomeScope {
  const requestedProgramId=text(programValue).trim();
  if(!requestedProgramId||requestedProgramId.includes('*')||requestedProgramId.includes('%'))throw new ActionError('올바른 프로그램 범위를 입력하세요.');
  const program=db.prepare('SELECT id FROM programs WHERE id=?').get(requestedProgramId) as {id:string}|undefined;
  if(!program)throw new ActionError('프로그램을 찾을 수 없습니다.');
  if(!runSupplied)return {programId:program.id,runId:null};
  const requestedRunId=text(runValue).trim();
  if(!requestedRunId||requestedRunId.includes('*')||requestedRunId.includes('%'))throw new ActionError('올바른 차수 범위를 입력하세요.');
  const run=db.prepare('SELECT id,program_id FROM program_runs WHERE id=?').get(requestedRunId) as {id:string;program_id:string}|undefined;
  if(!run)throw new ActionError('차수를 찾을 수 없습니다.');
  if(run.program_id!==program.id)throw new ActionError('선택한 프로그램에 속한 차수가 아닙니다.');
  return {programId:program.id,runId:run.id};
}
function outcomeApplication(db:DatabaseSync,body:Record<string,unknown>):{scope:OutcomeScope;application:{id:number;program_id:string;run_id:string|null;status:string;run_program_id:string|null}} {
  const scope=canonicalOutcomeScope(db,body.programId,Object.prototype.hasOwnProperty.call(body,'runId'),body.runId);
  const applicationId=Number(body.applicationId);
  if(!Number.isInteger(applicationId)||applicationId<=0)throw new ActionError('올바른 신청 기록을 선택하세요.');
  const application=db.prepare('SELECT a.id,a.program_id,a.run_id,a.status,r.program_id AS run_program_id FROM applications a LEFT JOIN program_runs r ON r.id=a.run_id WHERE a.id=?').get(applicationId) as {id:number;program_id:string;run_id:string|null;status:string;run_program_id:string|null}|undefined;
  if(!application)throw new ActionError('신청 기록을 찾을 수 없습니다.');
  if(application.program_id!==scope.programId||(scope.runId!==null&&application.run_id!==scope.runId)||(application.run_id!==null&&application.run_program_id!==scope.programId))throw new ActionError('선택한 성과 범위에 속한 신청 기록만 저장할 수 있습니다.');
  if(['취소','중도탈락'].includes(application.status))throw new ActionError('취소·중도탈락 신청에는 성과 결과를 저장할 수 없습니다.');
  return {scope,application};
}
function nextQueueNumber(db:DatabaseSync,programId:string){return ((db.prepare('SELECT COALESCE(MAX(queue_number),0)+1 AS next FROM applications WHERE program_id=?').get(programId) as {next:number}).next)||1}
function requestIp(request:Request){void request;return 'local'}

const NEVER_AUDIT_KEYS=new Set(['pin','pin_hash','password','session_secret','cookie','authorization','token','secret','phone','memo','note','comment','score','pre_score','post_score','not_completed_reason','status_reason']);
function sanitizeAuditPayload(value:unknown):unknown {
  if(value===null||value===undefined)return null;
  if(Array.isArray(value))return value.map(sanitizeAuditPayload);
  if(typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([key])=>!NEVER_AUDIT_KEYS.has(key.toLowerCase())).map(([key,item])=>[key,sanitizeAuditPayload(item)]));
  if(typeof value==='string')return value.slice(0,200);
  return value;
}
function changedFields(before:Record<string,unknown>|undefined,after:Record<string,unknown>,fields:string[]){return fields.filter(field=>String(before?.[field]??'')!==String(after[field]??''));}
function logChange(db:DatabaseSync, action:string, entityType:string, entityId:string|number, before:unknown, after:unknown, summary:string, requestedActor?:string, reason='',ipAddress='local') {
  const createdAt=new Date().toLocaleString('sv-SE',{timeZone:'Asia/Seoul'});
  const safeBefore=sanitizeAuditPayload(before),safeAfter=sanitizeAuditPayload(after);
  db.prepare('INSERT INTO audit_logs (created_at,actor,action,entity_type,entity_id,before_json,after_json,summary,reason,ip_address) VALUES (?,?,?,?,?,?,?,?,?,?)').run(createdAt,requestedActor?.trim()||'SYSTEM',action,entityType,String(entityId),safeBefore?JSON.stringify(safeBefore):'',safeAfter?JSON.stringify(safeAfter):'',summary.slice(0,200),reason.slice(0,200),ipAddress);
}
function backupFiles() {
  const source=getDatabasePath(), directory=getBackupDirectory(), extension=path.extname(source)||'.sqlite', base=path.basename(source,extension);
  if(!existsSync(directory)) return [];
  return readdirSync(directory).filter(name=>name.startsWith(`${base}-backup-`)&&name.endsWith(extension)).map(name=>{const fullPath=path.join(directory,name),stat=statSync(fullPath);return {name,path:fullPath,size:stat.size,modified_at:stat.mtime.toISOString()}}).sort((a,b)=>b.modified_at.localeCompare(a.modified_at));
}
function validateBackup(filePath:string) {
  const source=getDatabasePath(), resolved=path.resolve(filePath),backupDirectory=path.resolve(getBackupDirectory());
  if(path.dirname(resolved)!==backupDirectory||!path.basename(resolved).startsWith(`${path.basename(source,path.extname(source))}-backup-`)||!existsSync(resolved)) throw new ActionError('설정된 백업 폴더의 백업 파일만 선택할 수 있습니다.');
  const candidate=new DatabaseSync(resolved,{readOnly:true});
  try { const integrity=candidate.prepare('PRAGMA integrity_check').get() as {integrity_check:string}; const tables=(candidate.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {name:string}[]).map(row=>row.name); const required=['participants','programs','program_runs','sessions','applications','attendance','settings']; const missing=required.filter(name=>!tables.includes(name)); if(integrity.integrity_check!=='ok'||missing.length) throw new ActionError(`백업 점검 실패${missing.length?`: 누락 테이블 ${missing.join(', ')}`:''}`); return {ok:true,message:'무결성 점검 정상',tables:tables.length}; } finally { candidate.close(); }
}

function staffSnapshot(currentUser:SafeUser) {
  const settings=Object.fromEntries((rows(`SELECT key,value FROM settings WHERE key='center_name'`) as {key:string;value:string}[]).map(item=>[item.key,item.value]));
  return {
    settings,
    databasePath:'로컬 데이터베이스',
    storageInfo:{architecture:'단일 서버 프로세스',journalMode:'DELETE'},
    participants:rows(`SELECT p.id,p.name,p.gender,p.age,p.member_status,COUNT(DISTINCT a.id) AS application_count,COUNT(DISTINCT CASE WHEN at.status IN ('참석','보강') THEN at.id END) AS attended_count FROM participants p LEFT JOIN applications a ON a.participant_id=p.id LEFT JOIN attendance at ON at.application_id=a.id GROUP BY p.id ORDER BY p.name,p.id`),
    duplicateGroups:[],
    programs:rows(`SELECT p.id,p.name,p.category,p.delivery_type,p.session_count,p.recurrence,p.location,p.manager,p.capacity,p.status,COUNT(DISTINCT r.id) AS run_count,COUNT(DISTINCT a.id) AS applicant_count FROM programs p LEFT JOIN program_runs r ON r.program_id=p.id LEFT JOIN applications a ON a.program_id=p.id GROUP BY p.id ORDER BY p.created_at DESC`),
    runs:rows(`SELECT r.id,r.program_id,r.round_number,r.label,r.start_date,r.status,r.closed_at,r.closed_by,p.name AS program_name,p.delivery_type,p.session_count,p.capacity,p.manager,COUNT(DISTINCT a.id) AS applicant_count FROM program_runs r JOIN programs p ON p.id=r.program_id LEFT JOIN applications a ON a.run_id=r.id GROUP BY r.id ORDER BY r.start_date DESC,r.round_number DESC`),
    sessions:rows(`SELECT s.id,s.run_id,s.session_number,s.session_date,s.session_time,s.location,s.attendance_status,s.attendance_closed_at,s.attendance_closed_by,r.program_id,r.label AS run_label,p.name AS program_name FROM sessions s JOIN program_runs r ON r.id=s.run_id JOIN programs p ON p.id=r.program_id ORDER BY s.session_date DESC,s.session_time`),
    applications:rows(`SELECT a.id,a.participant_id,a.program_id,a.run_id,a.applied_at,a.status,a.queue_number,CASE WHEN TRIM(COALESCE(a.status_reason,''))<>'' THEN 1 ELSE 0 END AS reason_present,p.name AS participant_name,p.gender,p.age,p.member_status,pr.name AS program_name,COALESCE(r.label,'차수 미배정') AS run_label,pr.delivery_type,pr.session_count,r.start_date FROM applications a JOIN participants p ON p.id=a.participant_id JOIN programs pr ON pr.id=a.program_id LEFT JOIN program_runs r ON r.id=a.run_id ORDER BY a.applied_at DESC,a.id DESC`),
    attendance:rows(`SELECT at.id,at.application_id,at.session_id,at.status,a.participant_id,a.run_id,s.session_number,s.session_date,pr.name AS program_name,r.label AS run_label FROM attendance at JOIN applications a ON a.id=at.application_id JOIN sessions s ON s.id=at.session_id AND s.run_id=a.run_id JOIN program_runs r ON r.id=a.run_id AND r.program_id=a.program_id JOIN programs pr ON pr.id=a.program_id ORDER BY s.session_date DESC`),
    certificates:[],backupFiles:[],users:[],currentUser,
    assessmentCatalog:rows(`SELECT id,name,min_score,max_score,active,created_at,version,description FROM assessment_catalog ORDER BY active DESC,name`),
    programAssessments:rows(`SELECT pa.program_id,pa.assessment_id,pa.sort_order,a.name,a.min_score,a.max_score,a.active FROM program_assessments pa JOIN assessment_catalog a ON a.id=pa.assessment_id ORDER BY pa.program_id,pa.sort_order,a.name`),
    assessmentScores:[],
    satisfactionSurveys:[],
    scheduleEvents:[],
    operationalMetrics:{
      unassignedApplications:(rows(`SELECT COUNT(*) AS count FROM applications WHERE run_id IS NULL AND status NOT IN ('취소','중도탈락','참가완료')`)[0] as {count:number}).count,
      reviewApplications:(rows(`SELECT COUNT(*) AS count FROM applications WHERE status IN ('신청','선정검토')`)[0] as {count:number}).count,
      openAttendanceSessions:(rows(`SELECT COUNT(*) AS count FROM sessions WHERE session_date<=date('now','localtime') AND attendance_status!='마감'`)[0] as {count:number}).count,
      missingPostAssessments:(rows(`SELECT COUNT(*) AS count FROM assessment_scores WHERE pre_score IS NOT NULL AND post_score IS NULL AND not_completed_reason=''`)[0] as {count:number}).count,
      missingSatisfaction:(rows(`SELECT COUNT(*) AS count FROM applications a WHERE a.status='참가완료' AND NOT EXISTS(SELECT 1 FROM satisfaction_surveys s WHERE s.application_id=a.id)`)[0] as {count:number}).count,
    },
  };
}

function adminSnapshot(currentUser:SafeUser) {
  const settings = Object.fromEntries((rows('SELECT key, value FROM settings') as {key:string;value:string}[]).map(item=>[item.key,item.value]));
  const participants=rows(`SELECT p.*, COUNT(DISTINCT a.id) AS application_count, COUNT(DISTINCT CASE WHEN at.status IN ('참석','보강') THEN at.id END) AS attended_count, MAX(s.session_date) AS last_visit FROM participants p LEFT JOIN applications a ON a.participant_id=p.id LEFT JOIN attendance at ON at.application_id=a.id LEFT JOIN sessions s ON s.id=at.session_id GROUP BY p.id ORDER BY p.created_at DESC`) as Record<string,unknown>[];
  const duplicateMap=new Map<string,Record<string,unknown>[]>();
  for(const participant of participants){const key=`${String(participant.name).trim()}|${String(participant.phone).replace(/\D/g,'')}`;if(!String(participant.phone).replace(/\D/g,''))continue;duplicateMap.set(key,[...(duplicateMap.get(key)||[]),participant]);}
  return {
    settings,
    databasePath:getDatabasePath(),
    storageInfo:getStorageInfo(),
    participants,
    duplicateGroups:[...duplicateMap.values()].filter(group=>group.length>1),
    programs: rows(`SELECT p.*, COUNT(DISTINCT r.id) AS run_count, COUNT(DISTINCT a.id) AS applicant_count FROM programs p LEFT JOIN program_runs r ON r.program_id=p.id LEFT JOIN applications a ON a.program_id=p.id GROUP BY p.id ORDER BY p.created_at DESC`),
    runs: rows(`SELECT r.*, p.name AS program_name, p.delivery_type, p.session_count, p.capacity, p.manager, COUNT(DISTINCT a.id) AS applicant_count FROM program_runs r JOIN programs p ON p.id=r.program_id LEFT JOIN applications a ON a.run_id=r.id GROUP BY r.id ORDER BY r.start_date DESC, r.round_number DESC`),
    sessions: rows(`SELECT s.*, r.program_id, r.label AS run_label, p.name AS program_name FROM sessions s JOIN program_runs r ON r.id=s.run_id JOIN programs p ON p.id=r.program_id ORDER BY s.session_date DESC, s.session_time`),
    applications: rows(`SELECT a.*, p.name AS participant_name, p.gender, p.age, p.phone, p.member_status, COALESCE(r.label,'차수 미배정') AS run_label, r.round_number, pr.name AS program_name, pr.delivery_type, pr.session_count, r.start_date FROM applications a JOIN participants p ON p.id=a.participant_id JOIN programs pr ON pr.id=a.program_id LEFT JOIN program_runs r ON r.id=a.run_id ORDER BY a.applied_at DESC, a.id DESC`),
    attendance: rows(`SELECT at.*, a.participant_id, a.run_id, p.name AS participant_name, s.session_number, s.session_date, s.session_time, pr.name AS program_name, r.label AS run_label FROM attendance at JOIN applications a ON a.id=at.application_id JOIN participants p ON p.id=a.participant_id JOIN sessions s ON s.id=at.session_id JOIN program_runs r ON r.id=a.run_id JOIN programs pr ON pr.id=a.program_id ORDER BY s.session_date DESC`),
    certificates: rows(`SELECT c.*, p.name AS participant_name FROM certificates c JOIN participants p ON p.id=c.participant_id ORDER BY c.issued_at DESC`),
    backupFiles:backupFiles(),
    users:rows(`SELECT id,username,display_name,role,active,created_at,failed_attempts,locked_until,last_login_at,pin_changed_at,must_change_pin FROM staff_users ORDER BY active DESC, display_name`),
    currentUser,
    assessmentCatalog: rows(`SELECT * FROM assessment_catalog ORDER BY active DESC, name`),
    programAssessments: rows(`SELECT pa.*,a.name,a.min_score,a.max_score,a.active FROM program_assessments pa JOIN assessment_catalog a ON a.id=pa.assessment_id ORDER BY pa.program_id,pa.sort_order,a.name`),
    assessmentScores: rows(`SELECT sc.*,a.name,a.min_score,a.max_score FROM assessment_scores sc JOIN assessment_catalog a ON a.id=sc.assessment_id ORDER BY sc.updated_at DESC`),
    satisfactionSurveys: rows(`SELECT * FROM satisfaction_surveys ORDER BY updated_at DESC`),
    scheduleEvents: rows(`SELECT e.*,p.name AS participant_name FROM schedule_events e JOIN participants p ON p.id=e.participant_id ORDER BY e.event_date DESC,e.all_day DESC,e.start_time`),
    operationalMetrics: {
      unassignedApplications:(rows(`SELECT COUNT(*) AS count FROM applications WHERE run_id IS NULL AND status NOT IN ('취소','중도탈락','참가완료')`)[0] as {count:number}).count,
      reviewApplications:(rows(`SELECT COUNT(*) AS count FROM applications WHERE status IN ('신청','선정검토')`)[0] as {count:number}).count,
      openAttendanceSessions:(rows(`SELECT COUNT(*) AS count FROM sessions WHERE session_date<=date('now','localtime') AND attendance_status!='마감'`)[0] as {count:number}).count,
      missingPostAssessments:(rows(`SELECT COUNT(*) AS count FROM assessment_scores WHERE pre_score IS NOT NULL AND post_score IS NULL AND not_completed_reason=''`)[0] as {count:number}).count,
      missingSatisfaction:(rows(`SELECT COUNT(*) AS count FROM applications a WHERE a.status='참가완료' AND NOT EXISTS(SELECT 1 FROM satisfaction_surveys s WHERE s.application_id=a.id)`)[0] as {count:number}).count,
      lockedUsers:(rows(`SELECT COUNT(*) AS count FROM staff_users WHERE locked_until>?`,new Date().toISOString())[0] as {count:number}).count,
      latestBackup:backupFiles()[0]||null,
    },
  };
}

function snapshot(currentUser:SafeUser) {
  if(currentUser.role==='관리자')return adminSnapshot(currentUser);
  if(currentUser.role==='일반 담당자')return staffSnapshot(currentUser);
  if(currentUser.role==='출석 입력 전용')return attendanceOnlySnapshot(getDatabase(),currentUser);
  throw new ActionError('허용되지 않은 사용자 역할입니다.');
}

async function handleGET(request:Request) {
  try {
    const db=getDatabase(),user=getAuthenticatedUser(request,db);
    if(!user)return loginRequired();
    const params=new URL(request.url).searchParams,resource=params.get('resource');
    if(resource==='outcomes'){
      if(user.must_change_pin)return Response.json({error:'관리자가 발급한 임시 PIN을 먼저 변경하세요.'},{status:403});
      if(!['관리자','일반 담당자'].includes(user.role))return Response.json({error:'성과 결과를 조회할 권한이 없습니다.'},{status:403});
      const programIds=params.getAll('programId'),runIds=params.getAll('runId');
      if(programIds.length!==1||runIds.length>1)throw new ActionError('성과 조회 범위를 하나만 지정하세요.');
      const scope=canonicalOutcomeScope(db,programIds[0],runIds.length===1,runIds[0]);
      const assessmentSql=scope.runId===null
        ?`SELECT sc.application_id,sc.assessment_id,sc.pre_score,sc.post_score,sc.pre_date,sc.post_date,sc.note,sc.not_completed_reason FROM assessment_scores sc JOIN applications a ON a.id=sc.application_id LEFT JOIN program_runs r ON r.id=a.run_id WHERE a.program_id=? AND a.status NOT IN ('취소','중도탈락') AND (a.run_id IS NULL OR r.program_id=?) ORDER BY sc.application_id,sc.assessment_id`
        :`SELECT sc.application_id,sc.assessment_id,sc.pre_score,sc.post_score,sc.pre_date,sc.post_date,sc.note,sc.not_completed_reason FROM assessment_scores sc JOIN applications a ON a.id=sc.application_id WHERE a.program_id=? AND a.run_id=? AND a.status NOT IN ('취소','중도탈락') ORDER BY sc.application_id,sc.assessment_id`;
      const satisfactionSql=scope.runId===null
        ?`SELECT ss.application_id,ss.score,ss.comment,ss.survey_version,ss.anonymous FROM satisfaction_surveys ss JOIN applications a ON a.id=ss.application_id LEFT JOIN program_runs r ON r.id=a.run_id WHERE a.program_id=? AND a.status NOT IN ('취소','중도탈락') AND (a.run_id IS NULL OR r.program_id=?) ORDER BY ss.application_id`
        :`SELECT ss.application_id,ss.score,ss.comment,ss.survey_version,ss.anonymous FROM satisfaction_surveys ss JOIN applications a ON a.id=ss.application_id WHERE a.program_id=? AND a.run_id=? AND a.status NOT IN ('취소','중도탈락') ORDER BY ss.application_id`;
      const values=scope.runId===null?[scope.programId,scope.programId]:[scope.programId,scope.runId];
      return Response.json({programId:scope.programId,runId:scope.runId,assessmentScores:db.prepare(assessmentSql).all(...values),satisfactionSurveys:db.prepare(satisfactionSql).all(...values)});
    }
    if(resource==='attendance'){
      if(user.must_change_pin)return Response.json({error:'관리자가 발급한 임시 PIN을 먼저 변경하세요.'},{status:403});
      if(!['관리자','일반 담당자'].includes(user.role))return Response.json({error:'출석 상세정보를 조회할 권한이 없습니다.'},{status:403});
      const sessionIds=params.getAll('sessionId');
      if(sessionIds.length!==1)throw new ActionError('출석 조회 회기를 하나만 지정하세요.');
      const requestedSessionId=sessionIds[0].trim();
      if(!requestedSessionId||['*','%','_'].includes(requestedSessionId))throw new ActionError('올바른 회기 ID를 입력하세요.');
      const scope=canonicalAttendanceScope(db,requestedSessionId);
      const attendance=db.prepare(`SELECT at.id,at.application_id,at.session_id,at.status,at.note,at.contacted_at,at.makeup_for_session_id FROM attendance at JOIN applications a ON a.id=at.application_id JOIN program_runs r ON r.id=a.run_id AND r.program_id=a.program_id WHERE at.session_id=? AND a.run_id=? AND a.program_id=? AND r.id=? AND r.program_id=? AND a.status NOT IN ('취소','중도탈락') ORDER BY at.application_id`).all(scope.sessionId,scope.runId,scope.programId,scope.runId,scope.programId);
      return Response.json({sessionId:scope.sessionId,runId:scope.runId,attendance});
    }
    if(resource==='schedule'){
      if(user.must_change_pin)return Response.json({error:'관리자가 발급한 임시 PIN을 먼저 변경하세요.'},{status:403});
      if(!['관리자','일반 담당자'].includes(user.role))return Response.json({error:'일정 정보를 조회할 권한이 없습니다.'},{status:403});
      const fromValues=params.getAll('from'),toValues=params.getAll('to');
      if(fromValues.length!==1||toValues.length!==1)throw new ActionError('일정 조회 시작일과 종료일을 하나씩 지정하세요.');
      const from=fromValues[0].trim(),to=toValues[0].trim();
      if(!isCanonicalCalendarDate(from)||!isCanonicalCalendarDate(to))throw new ActionError('올바른 일정 조회 날짜를 입력하세요.');
      const rangeDays=inclusiveCalendarDays(from,to);
      if(rangeDays<1)throw new ActionError('일정 조회 종료일은 시작일보다 빠를 수 없습니다.');
      if(rangeDays>42)throw new ActionError('일정 조회 범위는 최대 42일까지 지정할 수 있습니다.');
      const scheduleEvents=db.prepare(`SELECT id,event_type,color,participant_id,title,event_date,all_day,start_time,delivery_mode FROM schedule_events WHERE event_date>=? AND event_date<=? ORDER BY event_date,all_day DESC,start_time,id`).all(from,to);
      return Response.json({from,to,scheduleEvents});
    }
    if(resource==='application-reason'){
      if(user.must_change_pin)return Response.json({error:'관리자가 발급한 임시 PIN을 먼저 변경하세요.'},{status:403});
      if(!['관리자','일반 담당자'].includes(user.role))return Response.json({error:'신청 상태 사유를 조회할 권한이 없습니다.'},{status:403});
      const idValues=params.getAll('id');
      if(idValues.length!==1)throw new ActionError('신청 기록 ID를 하나만 지정하세요.');
      const rawId=idValues[0].trim();
      if(!/^[1-9][0-9]*$/.test(rawId))throw new ActionError('올바른 신청 기록 ID를 입력하세요.');
      const requestedId=Number(rawId);
      if(!Number.isSafeInteger(requestedId))throw new ActionError('올바른 신청 기록 ID를 입력하세요.');
      const application=db.prepare(`SELECT id,COALESCE(status_reason,'') AS status_reason FROM applications WHERE id=?`).get(requestedId) as {id:number;status_reason:string}|undefined;
      if(!application)return Response.json({error:'신청 기록을 찾을 수 없습니다.'},{status:404});
      return Response.json({applicationId:application.id,statusReason:application.status_reason});
    }
    if(resource==='participant'){
      if(user.must_change_pin)return Response.json({error:'관리자가 발급한 임시 PIN을 먼저 변경하세요.'},{status:403});
      if(!['관리자','일반 담당자'].includes(user.role))return Response.json({error:'참가자 상세정보를 조회할 권한이 없습니다.'},{status:403});
      const idValues=params.getAll('id');
      if(idValues.length!==1)throw new ActionError('참가자 ID를 하나만 지정하세요.');
      const requestedId=idValues[0].trim();
      if(requestedId.length>64||!/^P-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(requestedId))throw new ActionError('올바른 참가자 ID를 입력하세요.');
      const participant=db.prepare("SELECT id,name,phone,gender,age,member_status,COALESCE(note,'') AS note FROM participants WHERE id=?").get(requestedId);
      if(!participant)return Response.json({error:'참가자를 찾을 수 없습니다.'},{status:404});
      return Response.json({participant});
    }
    if(resource==='audit'){if(user.role!=='관리자'||user.must_change_pin)return Response.json({error:'관리자만 변경 이력을 조회할 수 있습니다.'},{status:403});return Response.json({auditLogs:db.prepare(`SELECT al.*,su.display_name AS actor_display_name FROM audit_logs al LEFT JOIN staff_users su ON su.id=al.actor ORDER BY al.id DESC LIMIT 300`).all()});}
    return Response.json(snapshot(user));
  }
  catch (error) { return error instanceof ActionError?Response.json({error:error.message},{status:400}):internalError(error); }
}

async function handlePOST(request:Request) {
  try {
    const requestError=validateMutationRequest(request);
    if(requestError)return Response.json({error:requestError.error},{status:requestError.status});
    const body = await request.json() as Record<string,unknown>;
    const db = getDatabase();
    const today = new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Seoul' });
    if(body.action==='login'){
      const username=text(body.username).trim().toLowerCase(),now=new Date(),nowIso=now.toISOString(),ip=requestIp(request),user=db.prepare('SELECT id,username,display_name,role,active,pin_hash,failed_attempts,locked_until,must_change_pin,last_login_at FROM staff_users WHERE username=?').get(username) as (SafeUser&{pin_hash:string;failed_attempts:number;locked_until:string|null})|undefined;
      if(user?.locked_until&&new Date(user.locked_until)>now)return Response.json({error:'계정 또는 PIN이 올바르지 않습니다.'},{status:401});
      if(!user||!user.active||!verifyPin(username,text(body.pin),user.pin_hash)){
        if(user){const failures=(user.failed_attempts||0)+1,lockedUntil=failures>=5?new Date(Date.now()+15*60*1000).toISOString():null;db.prepare('UPDATE staff_users SET failed_attempts=?,locked_until=? WHERE id=?').run(failures,lockedUntil,user.id);logChange(db,'로그인 실패','사용자',user.id,null,{failed_attempts:failures,locked:Boolean(lockedUntil)},'로그인 실패',user.id,'PIN 불일치',ip)}
        return Response.json({error:'계정 또는 PIN이 올바르지 않습니다.'},{status:401});
      }
      if(!user.pin_hash.startsWith('scrypt$')||user.pin_hash.split('$').length<3)db.prepare('UPDATE staff_users SET pin_hash=? WHERE id=?').run(hashPin(username,text(body.pin)),user.id);
      db.prepare('UPDATE staff_users SET failed_attempts=0,locked_until=NULL,last_login_at=? WHERE id=?').run(nowIso,user.id);
      invalidateAuthSession(request,db);
      const {secret}=createAuthSession(db,user.id,ip);const safeUser:SafeUser={id:user.id,username:user.username,display_name:user.display_name,role:user.role,active:user.active,must_change_pin:user.must_change_pin,last_login_at:nowIso};logChange(db,'로그인','사용자',user.id,null,{role:user.role},'로그인',user.id,'',ip);const response=Response.json(snapshot(safeUser));response.headers.append('Set-Cookie',sessionCookie(secret));return response;
    }
    const user=getAuthenticatedUser(request,db);
    if(!user)return loginRequired('로그인이 만료되었습니다.');
    const action=text(body.action);if(user.must_change_pin&&!['changeMyPin','logout'].includes(action))return Response.json({error:'관리자가 발급한 임시 PIN을 먼저 변경하세요.'},{status:403});if(!canPerformAction(user,action))return Response.json({error:`${user.role} 권한으로는 이 작업을 수행할 수 없습니다.`},{status:403});
    let responseWarning='';
    let updatedApplicationReason:{applicationId:number;reasonPresent:boolean;statusReason:string}|undefined;
    let invalidateCurrentSession=false;
    if(body.action==='logout'){
      invalidateAuthSession(request,db);
      logChange(db,'로그아웃','사용자',user.id,null,null,'로그아웃',user.id,'',requestIp(request));
      return clearSessionCookie(Response.json({ok:true}));
    } else if (body.action === 'participantPhoneSearch') {
      const supplied=text(body.phone).trim();
      if(!supplied||!/^[0-9\s-]+$/.test(supplied))throw new ActionError('전화번호 전체를 입력하세요.');
      const normalized=supplied.replace(/\D/g,'');
      if(!/^\d{10,11}$/.test(normalized))throw new ActionError('전화번호는 전체 10~11자리를 입력하세요.');
      const matches=db.prepare(`SELECT id,name,member_status,REPLACE(REPLACE(TRIM(phone),'-',''),' ','') AS normalized_phone FROM participants WHERE REPLACE(REPLACE(TRIM(phone),'-',''),' ','')=? ORDER BY name,id LIMIT 5`).all(normalized) as {id:string;name:string;member_status:string;normalized_phone:string}[];
      const maskPhone=(value:string)=>value.length===11?`${value.slice(0,3)}-****-${value.slice(-4)}`:`${value.slice(0,3)}-***-${value.slice(-4)}`;
      return Response.json({results:matches.map(({id,name,member_status,normalized_phone})=>({id,name,member_status,masked_phone:maskPhone(normalized_phone)}))});
    } else if (body.action === 'createParticipant') {
      const duplicate=db.prepare(`SELECT id,name,phone FROM participants WHERE TRIM(name)=TRIM(?) AND REPLACE(REPLACE(phone,'-',''),' ','')=REPLACE(REPLACE(?,'-',''),' ','')`).get(text(body.name),text(body.phone)) as {id:string;name:string;phone:string}|undefined;
      if(duplicate) return Response.json({error:`동일한 이름과 연락처의 참가자(${duplicate.id})가 이미 있습니다. 기존 참가자를 확인하거나 중복 병합을 이용하세요.`,duplicate:{id:duplicate.id,name:duplicate.name,phoneMatched:true}},{status:409});
      const id = `P-${today.slice(0,4)}-${String(Date.now()).slice(-6)}`;
      db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,text(body.name),text(body.gender),Number(body.age||0),text(body.phone),text(body.memberStatus),text(body.note),today);
      const programIds = Array.isArray(body.programIds) ? body.programIds.map(text) : [];
      const insertApplication = db.prepare(`INSERT OR IGNORE INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES (?,?,NULL,?,'신청',?,?)`);
      for (const programId of programIds) insertApplication.run(id,programId,today,nextQueueNumber(db,programId),today);
      logChange(db,'등록','참가자',id,null,{created:true,initial_program_count:programIds.length},'참가자 등록',user.id,'',requestIp(request));
    } else if (body.action === 'updateParticipant') {
      const before=db.prepare('SELECT * FROM participants WHERE id=?').get(text(body.id)) as Record<string,unknown>|undefined;
      if(!before)throw new ActionError('참가자를 찾을 수 없습니다.');
      const participantId=String(before.id),duplicate=db.prepare(`SELECT id,name,phone FROM participants WHERE id<>? AND TRIM(name)=TRIM(?) AND REPLACE(REPLACE(phone,'-',''),' ','')=REPLACE(REPLACE(?,'-',''),' ','')`).get(participantId,text(body.name),text(body.phone)) as {id:string;name:string;phone:string}|undefined;
      if(duplicate) return Response.json({error:`수정하려는 정보가 기존 참가자(${duplicate.id})와 중복됩니다. 중복 병합을 이용하세요.`,duplicate:{id:duplicate.id,name:duplicate.name,phoneMatched:true}},{status:409});
      db.prepare('UPDATE participants SET name=?,gender=?,age=?,phone=?,member_status=?,note=? WHERE id=?').run(text(body.name),text(body.gender),Number(body.age||0),text(body.phone),text(body.memberStatus),text(body.note),participantId);
      const after={name:text(body.name),gender:text(body.gender),age:Number(body.age||0),phone:text(body.phone),member_status:text(body.memberStatus),note:text(body.note)};const fields=changedFields(before as Record<string,unknown>|undefined,after,['name','gender','age','phone','member_status','note']);
      logChange(db,'수정','참가자',participantId,null,{changed_fields:fields,name_changed:fields.includes('name'),phone_changed:fields.includes('phone'),memo_changed:fields.includes('note')},'참가자 기본정보 수정',user.id,'',requestIp(request));
    } else if (body.action === 'createProgram') {
      const id = `PRG-${String(Date.now()).slice(-6)}`;
      const name=text(body.name).trim(),sessionCount=Number(body.sessionCount),startDate=text(body.startDate),capacity=body.deliveryType==='1:1'?1:Number(body.capacity||10);
      if(!name||!Number.isInteger(sessionCount)||sessionCount<1||!Number.isInteger(capacity)||capacity<1||!isCanonicalCalendarDate(startDate))throw new ActionError('프로그램명, 회기 수, 정원과 첫 회기 날짜를 올바르게 입력하세요.');
      db.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,name,text(body.category),text(body.deliveryType),sessionCount,text(body.recurrence),text(body.location),text(body.manager),capacity,'운영 중',today);
      const runId=createRun(db,id,1,String(body.runLabel||'1차'),startDate,String(body.time));
      const createdProgram=db.prepare('SELECT id,manager,capacity FROM programs WHERE id=?').get(id) as {id:string;manager:string;capacity:number};
      const createdRun=db.prepare('SELECT id FROM program_runs WHERE id=? AND program_id=?').get(runId,createdProgram.id) as {id:string};
      const createdSessionCount=(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE run_id=?').get(createdRun.id) as {count:number}).count;
      logChange(db,'program_create','프로그램',createdProgram.id,null,{run_id:createdRun.id,session_count:createdSessionCount,capacity_present:createdProgram.capacity>0,manager_present:Boolean(createdProgram.manager.trim())},'프로그램 및 최초 차수 생성',user.id,'',requestIp(request));
    } else if (body.action === 'createRun') {
      const requestedProgramId=text(body.programId),program=db.prepare('SELECT id FROM programs WHERE id=?').get(requestedProgramId) as {id:string}|undefined;
      if(!program)throw new ActionError('프로그램을 찾을 수 없습니다.');
      const last = db.prepare('SELECT COALESCE(MAX(round_number),0) AS max_round FROM program_runs WHERE program_id=?').get(program.id) as {max_round:number};
      const runId=createRun(db,program.id,last.max_round+1,String(body.label),String(body.startDate),String(body.time));
      const createdRun=db.prepare('SELECT id,program_id FROM program_runs WHERE id=? AND program_id=?').get(runId,program.id) as {id:string;program_id:string};
      const createdSessionCount=(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE run_id=?').get(createdRun.id) as {count:number}).count;
      logChange(db,'run_create','차수',createdRun.id,null,{program_id:createdRun.program_id,session_count:createdSessionCount},'프로그램 차수 생성',user.id,'',requestIp(request));
    } else if (body.action === 'updateProgram') {
      const requestedProgramId=text(body.id),before=db.prepare('SELECT id,name,category,delivery_type,location,manager,capacity,status FROM programs WHERE id=?').get(requestedProgramId) as Record<string,unknown>|undefined;
      if(!before)throw new ActionError('프로그램을 찾을 수 없습니다.');
      const programId=String(before.id),capacity=body.deliveryType==='1:1'?1:Number(body.capacity||10),after={name:text(body.name),category:text(body.category),delivery_type:text(body.deliveryType),location:text(body.location),manager:text(body.manager),capacity,status:text(body.status)};
      const allowedStatuses=['운영 중','운영 종료','일시 중단'];
      if(!after.name.trim()||!after.category.trim()||!after.manager.trim()||!after.location.trim()||!Number.isInteger(capacity)||capacity<1||!allowedStatuses.includes(after.status))throw new ActionError('프로그램 정보를 올바르게 입력하세요.');
      const fields=changedFields(before,after,['name','category','delivery_type','location','manager','capacity','status']);
      const affectedSessionCount=(db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE run_id IN (SELECT id FROM program_runs WHERE program_id=?) AND COALESCE(location,'')<>?`).get(programId,after.location) as {count:number}).count;
      db.prepare('UPDATE programs SET name=?,category=?,delivery_type=?,location=?,manager=?,capacity=?,status=? WHERE id=?').run(after.name,after.category,after.delivery_type,after.location,after.manager,after.capacity,after.status,programId);
      db.prepare('UPDATE sessions SET location=? WHERE run_id IN (SELECT id FROM program_runs WHERE program_id=?)').run(after.location,programId);
      logChange(db,'program_update','프로그램',programId,null,{changed_fields:fields,...(fields.includes('status')?{status_before:String(before.status),status_after:after.status}:{}),name_changed:fields.includes('name'),manager_changed:fields.includes('manager'),location_changed:fields.includes('location'),session_location_updated:affectedSessionCount>0,affected_session_count:affectedSessionCount},'프로그램 정보 수정',user.id,'',requestIp(request));
    } else if (body.action === 'updateRunStatus') {
      const statuses=['모집 예정','모집 중','모집 마감','참가자 확정','진행 중','종료','취소'],status=text(body.status),id=text(body.id),before=db.prepare('SELECT * FROM program_runs WHERE id=?').get(id);
      if(!before||!statuses.includes(status))throw new ActionError('올바른 차수 운영 상태를 선택하세요.');
      const reason=text(body.reason).trim(),runId=String((before as Record<string,unknown>).id);if(status==='취소'&&!reason)throw new ActionError('차수 취소 사유를 입력하세요.');const now=new Date().toISOString(),closed=['종료','취소'].includes(status);db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE program_runs SET status=?,closed_at=?,closed_by=? WHERE id=?').run(status,closed?now:null,closed?user.display_name:null,runId);if(status==='진행 중')db.prepare(`UPDATE applications SET status='참가중',status_updated_at=? WHERE run_id=? AND status IN ('신청','선정검토','참가대기')`).run(now,runId);if(status==='종료')db.prepare(`UPDATE applications SET status='참가완료',status_updated_at=? WHERE run_id=? AND status='참가중'`).run(now,runId);if(status==='취소')db.prepare(`UPDATE applications SET status='취소',status_reason=?,status_updated_at=? WHERE run_id=? AND status NOT IN ('참가완료','중도탈락','취소')`).run(reason,now,runId);logChange(db,'차수 상태','차수',runId,{status:String((before as Record<string,unknown>).status)},{status,reason_present:Boolean(reason)},`차수 상태를 ${status}(으)로 변경`,user.id,'',requestIp(request));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    } else if (body.action === 'updateSession') {
      const before=db.prepare('SELECT id,session_date,session_time,location FROM sessions WHERE id=?').get(text(body.id)) as {id:string;session_date:string;session_time:string;location:string}|undefined;
      if(!before)throw new ActionError('회기를 찾을 수 없습니다.');
      db.prepare('UPDATE sessions SET session_date=?,session_time=?,location=? WHERE id=?').run(text(body.sessionDate),text(body.sessionTime),text(body.location),before.id);
      const after={session_date:text(body.sessionDate),session_time:text(body.sessionTime),location:text(body.location)};logChange(db,'일정 수정','회기',before.id,{session_date:before.session_date,session_time:before.session_time,location:before.location},after,'프로그램 회기 일정 수정',user.id,'',requestIp(request));
    } else if (body.action === 'createScheduleEvent') {
      const participantId=text(body.participantId),title=text(body.title).trim(),eventDate=text(body.eventDate),eventType=text(body.eventType)||'상담',color=text(body.color)||'green',allDay=body.allDay?1:0,startTime=allDay?'':text(body.startTime),endTime=allDay?'':text(body.endTime),recurrence=text(body.recurrence)||'1회',deliveryMode=text(body.deliveryMode)||'대면';
      if(!participantId||!title||!isCanonicalCalendarDate(eventDate))throw new ActionError('참가자, 일정 제목과 올바른 날짜를 입력하세요.');
      if(typeof body.allDay!=='boolean')throw new ActionError('하루 종일 여부를 올바르게 입력하세요.');
      if(!db.prepare('SELECT id FROM participants WHERE id=?').get(participantId))throw new ActionError('참가자를 찾을 수 없습니다.');
      if(!allDay&&(!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)||endTime<=startTime))throw new ActionError('올바른 시작·종료시간을 입력하고 종료시간을 시작시간보다 늦게 설정하세요.');
      if(!['상담','프로그램','기타'].includes(eventType))throw new ActionError('올바른 프로그램 종류를 선택하세요.');
      if(!['green','orange','blue','purple','gray'].includes(color))throw new ActionError('올바른 일정 색상을 선택하세요.');
      if(!['1회','매주','격주','매월'].includes(recurrence))throw new ActionError('올바른 프로그램 주기를 선택하세요.');
      if(!['대면','비대면','전화','가정방문'].includes(deliveryMode))throw new ActionError('올바른 프로그램 방식을 선택하세요.');
      const id=`EVT-${String(Date.now()).slice(-10)}`,createdAt=new Date().toISOString();
      db.prepare('INSERT INTO schedule_events (id,event_type,color,participant_id,title,event_date,all_day,start_time,end_time,recurrence,delivery_mode,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,eventType,color,participantId,title,eventDate,allDay,startTime,endTime,recurrence,deliveryMode,createdAt);
      logChange(db,'일정 등록','일정',id,null,{event_type:eventType,event_date:eventDate,all_day:Boolean(allDay),start_time:startTime,end_time:endTime,recurrence,delivery_mode:deliveryMode,participant_id:participantId,title_present:Boolean(title)},'일정 등록',user.id,'',requestIp(request));
    } else if (body.action === 'apply') {
      const programId=text(body.programId);db.prepare(`INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES (?,?,NULL,?,'신청',?,?) ON CONFLICT(participant_id,program_id) DO UPDATE SET status='신청',status_reason='',status_updated_at=excluded.status_updated_at`).run(text(body.participantId),programId,today,nextQueueNumber(db,programId),today);
    } else if (body.action === 'assignRun') {
      const run = db.prepare('SELECT r.program_id,r.status,p.capacity FROM program_runs r JOIN programs p ON p.id=r.program_id WHERE r.id=?').get(text(body.runId)) as {program_id:string;status:string;capacity:number}|undefined;
      const application = db.prepare('SELECT program_id FROM applications WHERE id=?').get(Number(body.applicationId)) as {program_id:string}|undefined;
      if (!run || !application || run.program_id!==application.program_id) throw new ActionError('같은 프로그램의 차수만 배정할 수 있습니다.');
      if(['종료','취소'].includes(run.status))throw new ActionError('종료·취소된 차수에는 참가자를 배정할 수 없습니다.');
      const assigned=db.prepare(`SELECT COUNT(*) AS count FROM applications WHERE run_id=? AND id<>? AND status NOT IN ('취소','중도탈락')`).get(text(body.runId),Number(body.applicationId)) as {count:number};
      if(assigned.count>=run.capacity)responseWarning=`정원 ${run.capacity}명을 초과합니다. 경고 상태로 배정했습니다.`;
      db.prepare(`UPDATE applications SET run_id=?, status=CASE WHEN status IN ('신청','선정검토') THEN '참가대기' ELSE status END,assigned_at=?,status_updated_at=? WHERE id=?`).run(text(body.runId),new Date().toISOString(),new Date().toISOString(),Number(body.applicationId));
    } else if (body.action === 'applyToRun') {
      const run = db.prepare('SELECT r.program_id,r.status,p.capacity FROM program_runs r JOIN programs p ON p.id=r.program_id WHERE r.id=?').get(text(body.runId)) as {program_id:string;status:string;capacity:number}|undefined;
      if (!run) throw new ActionError('차수를 찾을 수 없습니다.');
      if(['종료','취소'].includes(run.status))throw new ActionError('종료·취소된 차수에는 신청자를 추가할 수 없습니다.');
      const assigned = db.prepare(`SELECT COUNT(*) AS count FROM applications WHERE run_id=? AND status NOT IN ('취소','중도탈락')`).get(text(body.runId)) as {count:number};
      if (assigned.count>=run.capacity) responseWarning=`정원 ${run.capacity}명을 초과합니다. 경고 상태로 신청자를 추가했습니다.`;
      db.prepare(`INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at,assigned_at) VALUES (?,?,?,?,'참가대기',?,?,?) ON CONFLICT(participant_id,program_id) DO UPDATE SET run_id=excluded.run_id,status='참가대기',assigned_at=excluded.assigned_at,status_updated_at=excluded.status_updated_at`).run(text(body.participantId),run.program_id,text(body.runId),today,nextQueueNumber(db,run.program_id),new Date().toISOString(),new Date().toISOString());
    } else if (body.action === 'applicationStatus') {
      const id=Number(body.id),status=text(body.status),reason=text(body.reason).trim(),statuses=['신청','선정검토','참가대기','참가중','참가완료','중도탈락','취소'],before=db.prepare('SELECT * FROM applications WHERE id=?').get(id);
      if(!before||!statuses.includes(status))throw new ActionError('올바른 신청 상태를 선택하세요.');
      if(['중도탈락','취소'].includes(status)&&!reason)throw new ActionError(`${status} 사유를 입력하세요.`);
      const applicationId=Number((before as Record<string,unknown>).id);db.prepare('UPDATE applications SET status=?,status_reason=?,status_updated_at=? WHERE id=?').run(status,reason,new Date().toISOString(),applicationId);
      const canonical=db.prepare(`SELECT id,COALESCE(status_reason,'') AS status_reason FROM applications WHERE id=?`).get(applicationId) as {id:number;status_reason:string};
      updatedApplicationReason={applicationId:canonical.id,reasonPresent:canonical.status_reason.trim()!=='',statusReason:canonical.status_reason};
      logChange(db,'상태 변경','신청',applicationId,{status:(before as Record<string,unknown>).status},{status,reason_present:Boolean(reason)},`신청 현황을 ${status}(으)로 변경`,user.id,'',requestIp(request));
    } else if (body.action === 'attendance') {
      const requestedSessionId=text(body.sessionId),requestedApplicationId=Number(body.applicationId),status=text(body.status),noteText=text(body.note).trim(),validStatuses=['참석','결석','보강','취소','노쇼','기타','미입력'];if(!validStatuses.includes(status))throw new ActionError('올바른 출석 상태를 선택하세요.');if(['결석','취소','노쇼','기타'].includes(status)&&!noteText)throw new ActionError(`${status} 사유나 연락 결과를 입력하세요.`);const sessionState=canonicalAttendanceScope(db,requestedSessionId);if(sessionState.attendanceStatus==='마감')throw new ActionError('마감된 회기의 출석은 수정할 수 없습니다. 관리자가 회기를 다시 열어야 합니다.');const application=db.prepare('SELECT id,run_id,program_id,status FROM applications WHERE id=?').get(requestedApplicationId) as AttendanceApplication|undefined;if(!application||!attendanceApplicationMatchesScope(application,sessionState))throw new ActionError('해당 프로그램과 차수에 배정된 참가자만 출석을 입력할 수 있습니다.');if(['취소','중도탈락'].includes(application.status))throw new ActionError('취소·중도탈락 신청에는 출석을 입력할 수 없습니다.');const sessionId=sessionState.sessionId,applicationId=application.id,makeupFor=text(body.makeupForSessionId);if(makeupFor){const makeupSession=db.prepare('SELECT id,run_id FROM sessions WHERE id=?').get(makeupFor) as {id:string;run_id:string}|undefined;if(!makeupSession)throw new ActionError('보강 대상 회기를 찾을 수 없습니다.');if(makeupSession.run_id!==sessionState.runId)throw new ActionError('같은 차수의 회기만 보강 대상으로 지정할 수 있습니다.');}
      const before=db.prepare('SELECT status,note,contacted_at,makeup_for_session_id FROM attendance WHERE application_id=? AND session_id=?').get(applicationId,sessionId) as Record<string,unknown>|undefined;db.prepare(`INSERT INTO attendance (application_id,session_id,status,note,contacted_at,makeup_for_session_id) VALUES (?,?,?,?,?,?) ON CONFLICT(application_id,session_id) DO UPDATE SET status=excluded.status,note=excluded.note,contacted_at=excluded.contacted_at,makeup_for_session_id=excluded.makeup_for_session_id`).run(applicationId,sessionId,status,noteText,text(body.contactedAt)||null,makeupFor||null);logChange(db,'출석 입력','출석',`${applicationId}:${sessionId}`,{status:before?.status??'미입력'},{status,note_changed:String(before?.note??'')!==noteText,contact_checked:Boolean(text(body.contactedAt)),makeup_changed:String(before?.makeup_for_session_id??'')!==makeupFor},`출석 상태를 ${status}(으)로 변경`,user.id,'',requestIp(request));
    } else if (body.action === 'attendanceBulk') {
      const applicationIds=[...new Set(Array.isArray(body.applicationIds)?body.applicationIds.map(Number).filter(Number.isFinite):[])];
      const requestedSessionId=text(body.sessionId),status=text(body.status);
      if(!['참석','결석','보강','취소','노쇼','기타','미입력'].includes(status))throw new ActionError('올바른 출석 상태를 선택하세요.');
      if(!applicationIds.length)throw new ActionError('출석을 입력할 참가자를 선택하세요.');
      const sessionState=canonicalAttendanceScope(db,requestedSessionId);
      if(sessionState.attendanceStatus==='마감')throw new ActionError('마감된 회기의 출석은 수정할 수 없습니다.');
      const selectedApplications=db.prepare(`SELECT id,run_id,program_id,status FROM applications WHERE id IN (${applicationIds.map(()=>'?').join(',')})`).all(...applicationIds) as AttendanceApplication[];
      if(selectedApplications.length!==applicationIds.length)throw new ActionError('존재하지 않는 신청 기록이 포함되어 있습니다.');
      if(selectedApplications.some(application=>!attendanceApplicationMatchesScope(application,sessionState)))throw new ActionError('해당 프로그램과 차수에 배정된 참가자만 일괄 출석을 입력할 수 있습니다.');
      if(selectedApplications.some(application=>['취소','중도탈락'].includes(application.status)))throw new ActionError('취소·중도탈락 신청에는 출석을 입력할 수 없습니다.');
      const sessionId=sessionState.sessionId,canonicalApplicationIds=selectedApplications.map(application=>application.id);
      db.exec('BEGIN IMMEDIATE');
      try { for(const applicationId of canonicalApplicationIds){const before=db.prepare('SELECT status FROM attendance WHERE application_id=? AND session_id=?').get(applicationId,sessionId) as {status:string}|undefined;db.prepare(`INSERT INTO attendance (application_id,session_id,status,note) VALUES (?,?,?,'') ON CONFLICT(application_id,session_id) DO UPDATE SET status=excluded.status`).run(applicationId,sessionId,status);logChange(db,'출석 일괄 입력','출석',`${applicationId}:${sessionId}`,{status:before?.status??'미입력'},{status},`일괄 출석 상태를 ${status}(으)로 변경`,user.id,'',requestIp(request));}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    } else if (body.action === 'closeAttendanceSession') {
      const sessionId=text(body.sessionId),before=db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as Record<string,unknown>|undefined;if(!before)throw new ActionError('회기를 찾을 수 없습니다.');
      const scope=canonicalAttendanceScope(db,sessionId),canonicalSessionId=scope.sessionId;
      const active=(db.prepare(`SELECT COUNT(*) AS count FROM applications WHERE run_id=? AND program_id=? AND status NOT IN ('취소','중도탈락')`).get(scope.runId,scope.programId) as {count:number}).count,entered=(db.prepare(`SELECT COUNT(*) AS count FROM attendance at JOIN applications a ON a.id=at.application_id WHERE at.session_id=? AND a.run_id=? AND a.program_id=? AND a.status NOT IN ('취소','중도탈락') AND at.status!='미입력'`).get(scope.sessionId,scope.runId,scope.programId) as {count:number}).count;
      if(entered<active)throw new ActionError(`출석 미입력 ${active-entered}명이 있어 마감할 수 없습니다.`);
      db.prepare(`UPDATE sessions SET attendance_status='마감',attendance_closed_at=?,attendance_closed_by=? WHERE id=?`).run(new Date().toISOString(),user.display_name,canonicalSessionId);logChange(db,'출석 마감','회기',canonicalSessionId,{attendance_status:before.attendance_status},{attendance_status:'마감'},'회기 출석 입력 마감',user.id,'',requestIp(request));
    } else if (body.action === 'reopenAttendanceSession') {
      const requestedSessionId=text(body.sessionId),reason=text(body.reason).trim(),before=db.prepare('SELECT id,attendance_status FROM sessions WHERE id=?').get(requestedSessionId) as {id:string;attendance_status:string}|undefined;if(!before)throw new ActionError('회기를 찾을 수 없습니다.');if(!reason)throw new ActionError('마감 해제 사유를 입력하세요.');db.prepare(`UPDATE sessions SET attendance_status='작성 중',attendance_closed_at=NULL,attendance_closed_by=NULL,reopen_reason=? WHERE id=?`).run(reason,before.id);logChange(db,'출석 마감 해제','회기',before.id,{attendance_status:before.attendance_status},{attendance_status:'작성 중',reason_present:true},'회기 출석 마감 해제',user.id,'',requestIp(request));
    } else if (body.action === 'mergeParticipants') {
      const keepId=text(body.keepId),mergeId=text(body.mergeId);
      if(!keepId||!mergeId||keepId===mergeId) throw new ActionError('병합할 서로 다른 참가자를 선택하세요.');
      const keep=db.prepare('SELECT * FROM participants WHERE id=?').get(keepId) as Record<string,unknown>|undefined,source=db.prepare('SELECT * FROM participants WHERE id=?').get(mergeId) as Record<string,unknown>|undefined;
      if(!keep||!source) throw new ActionError('병합할 참가자를 찾을 수 없습니다.');
      if(String(keep.name).trim()!==String(source.name).trim()||String(keep.phone).replace(/\D/g,'')!==String(source.phone).replace(/\D/g,'')) throw new ActionError('이름과 연락처가 같은 중복 참가자만 병합할 수 있습니다.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const sourceApps=db.prepare('SELECT * FROM applications WHERE participant_id=?').all(mergeId) as {id:number;program_id:string}[];
        for(const sourceApp of sourceApps){const targetApp=db.prepare('SELECT id FROM applications WHERE participant_id=? AND program_id=?').get(keepId,sourceApp.program_id) as {id:number}|undefined;if(targetApp){const sourceAttendance=db.prepare('SELECT * FROM attendance WHERE application_id=?').all(sourceApp.id) as {session_id:string;status:string;note:string}[];for(const attendance of sourceAttendance){const existing=db.prepare('SELECT status FROM attendance WHERE application_id=? AND session_id=?').get(targetApp.id,attendance.session_id) as {status:string}|undefined;if(!existing)db.prepare('INSERT INTO attendance (application_id,session_id,status,note) VALUES (?,?,?,?)').run(targetApp.id,attendance.session_id,attendance.status,attendance.note);else if(existing.status==='미입력'&&attendance.status!=='미입력')db.prepare('UPDATE attendance SET status=?,note=? WHERE application_id=? AND session_id=?').run(attendance.status,attendance.note,targetApp.id,attendance.session_id);}db.prepare('DELETE FROM applications WHERE id=?').run(sourceApp.id);}else db.prepare('UPDATE applications SET participant_id=? WHERE id=?').run(keepId,sourceApp.id);}
        db.prepare('UPDATE certificates SET participant_id=? WHERE participant_id=?').run(keepId,mergeId);
        const mergedNote=[text(keep.note),text(source.note)].filter(Boolean).filter((value,index,array)=>array.indexOf(value)===index).join('\n[병합 메모] ');
        db.prepare('UPDATE participants SET note=? WHERE id=?').run(mergedNote,keepId);
        db.prepare('DELETE FROM participants WHERE id=?').run(mergeId);
        logChange(db,'병합','참가자',String(keep.id),{source_participant_id:String(source.id)},{merged:true,note_merged:Boolean(text(source.note)),source_application_count:sourceApps.length},`참가자 기록을 ${String(keep.id)}로 병합`,user.id,'',requestIp(request));
        db.exec('COMMIT');
      } catch(error){db.exec('ROLLBACK');throw error;}
    } else if (body.action === 'createUser') {
      const username=text(body.username).trim().toLowerCase(),pin=text(body.pin),role=text(body.role);if(!username||pin.length<6||/^([0-9])\1+$/.test(pin))throw new ActionError('계정명과 반복 숫자가 아닌 6자리 이상 PIN을 입력하세요.');if(!['관리자','일반 담당자','출석 입력 전용'].includes(role))throw new ActionError('올바른 권한을 선택하세요.');const id=`USR-${String(Date.now()).slice(-8)}`,now=new Date().toISOString();db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,pin_changed_at,must_change_pin) VALUES (?,?,?,?,?,1,?,?,1)').run(id,username,text(body.displayName),hashPin(username,pin),role,today,now);logChange(db,'계정 등록','사용자',id,null,{role,temporary_pin:true},'직원 계정 생성',user.id,'',requestIp(request));
    } else if (body.action === 'updateUser') {
      const requestedTargetId=text(body.id),target=db.prepare('SELECT * FROM staff_users WHERE id=?').get(requestedTargetId) as Record<string,unknown>|undefined;if(!target)throw new ActionError('사용자를 찾을 수 없습니다.');const targetId=String(target.id),nextRole=text(body.role),nextActive=body.active?1:0;if(target.role==='관리자'&&(nextRole!=='관리자'||!nextActive)){const admins=db.prepare(`SELECT COUNT(*) AS count FROM staff_users WHERE role='관리자' AND active=1`).get() as {count:number};if(admins.count<=1)throw new ActionError('마지막 관리자는 권한을 변경하거나 사용 중지할 수 없습니다.');}const pin=text(body.pin);if(pin&&(pin.length<6||/^([0-9])\1+$/.test(pin)))throw new ActionError('PIN은 반복 숫자가 아닌 6자리 이상이어야 합니다.');const securityChanged=Boolean(pin)||nextRole!==target.role||(!nextActive&&Boolean(target.active));db.exec('BEGIN IMMEDIATE');try{if(pin)db.prepare('UPDATE staff_users SET display_name=?,role=?,active=?,pin_hash=?,pin_changed_at=?,must_change_pin=1,failed_attempts=0,locked_until=NULL WHERE id=?').run(text(body.displayName),nextRole,nextActive,hashPin(String(target.username),pin),new Date().toISOString(),targetId);else db.prepare('UPDATE staff_users SET display_name=?,role=?,active=? WHERE id=?').run(text(body.displayName),nextRole,nextActive,targetId);if(securityChanged)db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(targetId);const fields=changedFields(target,{display_name:text(body.displayName),role:nextRole,active:nextActive},['display_name','role','active']);logChange(db,'계정 수정','사용자',targetId,{role:target.role,active:target.active},{role:nextRole,active:nextActive,changed_fields:fields,pin_reset:Boolean(pin)},'직원 계정 수정',user.id,'',requestIp(request));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}invalidateCurrentSession=securityChanged&&targetId===user.id;
    } else if (body.action === 'changeMyPin') {
      const current=text(body.currentPin),next=text(body.newPin),account=db.prepare('SELECT username,pin_hash FROM staff_users WHERE id=?').get(user.id) as {username:string;pin_hash:string}|undefined;if(!account||!verifyPin(account.username,current,account.pin_hash))throw new ActionError('현재 PIN이 올바르지 않습니다.');if(next.length<6||/^([0-9])\1+$/.test(next))throw new ActionError('새 PIN은 반복 숫자가 아닌 6자리 이상으로 입력하세요.');db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE staff_users SET pin_hash=?,pin_changed_at=?,must_change_pin=0 WHERE id=?').run(hashPin(account.username,next),new Date().toISOString(),user.id);db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id);logChange(db,'PIN 변경','사용자',user.id,null,{pin_changed:true},'PIN 변경',user.id,'',requestIp(request));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}return clearSessionCookie(Response.json({ok:true,loginRequired:true}));
    } else if (body.action === 'recordAccess') {
      const eventType=text(body.eventType),requestedTargetId=text(body.targetId);const events:Record<string,{roles:string[];action:string;entityType:string;summary:string}>={participant_view:{roles:['관리자','일반 담당자'],action:'참가자 조회',entityType:'참가자',summary:'참가자 참여 이력 조회'}};const event=events[eventType],participant=event&&event.roles.includes(user.role)?db.prepare('SELECT id FROM participants WHERE id=?').get(requestedTargetId) as {id:string}|undefined:undefined;if(!event||!participant)throw new ActionError('허용되지 않은 조회 이벤트입니다.');
      logChange(db,event.action,event.entityType,participant.id,null,null,event.summary,user.id,'',requestIp(request));
      return Response.json({ok:true});
    } else if (body.action === 'addAssessmentType') {
      const name=text(body.name).trim(),min=Number(body.minScore),max=Number(body.maxScore),version=text(body.version)||'1.0',description=text(body.description);if(!name||!Number.isFinite(min)||!Number.isFinite(max)||max<=min)throw new ActionError('검사명과 올바른 점수 범위를 입력하세요.');const id=`ASM-${String(Date.now()).slice(-8)}`;db.prepare('INSERT INTO assessment_catalog (id,name,min_score,max_score,active,created_at,version,description) VALUES (?,?,?,?,1,?,?,?)').run(id,name,min,max,today,version,description);logChange(db,'검사 추가','검사',id,null,{name,min,max,version},`${name} 검사 항목 추가`,user.id,'',requestIp(request));
    } else if (body.action === 'setAssessmentActive') {
      const assessmentType=db.prepare('SELECT id,active FROM assessment_catalog WHERE id=?').get(text(body.id)) as {id:string;active:number}|undefined;if(!assessmentType)throw new ActionError('검사 항목을 찾을 수 없습니다.');db.prepare('UPDATE assessment_catalog SET active=? WHERE id=?').run(body.active?1:0,assessmentType.id);logChange(db,'검사 상태 변경','검사',assessmentType.id,{active:assessmentType.active},{active:body.active?1:0},`검사 항목 ${body.active?'사용':'사용 중지'}`,user.id,'',requestIp(request));
    } else if (body.action === 'setProgramAssessments') {
      const program=db.prepare('SELECT id FROM programs WHERE id=?').get(text(body.programId)) as {id:string}|undefined;if(!program)throw new ActionError('프로그램을 찾을 수 없습니다.');const ids=Array.isArray(body.assessmentIds)?body.assessmentIds.map(text):[];db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM program_assessments WHERE program_id=?').run(program.id);const insert=db.prepare('INSERT INTO program_assessments (program_id,assessment_id,sort_order) VALUES (?,?,?)');ids.forEach((id,index)=>insert.run(program.id,id,index));logChange(db,'검사 구성','프로그램',program.id,null,{assessment_ids:ids},`프로그램 검사 ${ids.length}개 구성`,user.id,'',requestIp(request));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    } else if (body.action === 'saveAssessmentScore') {
      const {scope,application}=outcomeApplication(db,body),applicationId=application.id;
      const assessment=db.prepare('SELECT id,min_score,max_score FROM assessment_catalog WHERE id=?').get(text(body.assessmentId)) as {id:string;min_score:number;max_score:number}|undefined;if(!assessment)throw new ActionError('검사 항목을 찾을 수 없습니다.');
      if(!db.prepare('SELECT 1 FROM program_assessments WHERE program_id=? AND assessment_id=?').get(scope.programId,assessment.id))throw new ActionError('선택한 프로그램에 구성된 검사만 저장할 수 있습니다.');
      const pre=body.preScore===''||body.preScore==null?null:Number(body.preScore),postScore=body.postScore===''||body.postScore==null?null:Number(body.postScore),reason=text(body.notCompletedReason).trim();for(const value of [pre,postScore])if(value!==null&&(value<assessment.min_score||value>assessment.max_score))throw new ActionError(`점수는 ${assessment.min_score}~${assessment.max_score} 범위여야 합니다.`);if(pre===null&&postScore===null&&!reason)throw new ActionError('점수를 입력하거나 미실시 사유를 입력하세요.');const before=db.prepare('SELECT * FROM assessment_scores WHERE application_id=? AND assessment_id=?').get(applicationId,assessment.id) as Record<string,unknown>|undefined;const updatedAt=new Date().toISOString();db.prepare(`INSERT INTO assessment_scores (application_id,assessment_id,pre_score,post_score,note,updated_at,pre_date,post_date,not_completed_reason,assessor) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(application_id,assessment_id) DO UPDATE SET pre_score=excluded.pre_score,post_score=excluded.post_score,note=excluded.note,updated_at=excluded.updated_at,pre_date=excluded.pre_date,post_date=excluded.post_date,not_completed_reason=excluded.not_completed_reason,assessor=excluded.assessor`).run(applicationId,assessment.id,pre,postScore,text(body.note),updatedAt,text(body.preDate)||null,text(body.postDate)||null,reason,user.display_name);const saved=db.prepare('SELECT id FROM assessment_scores WHERE application_id=? AND assessment_id=?').get(applicationId,assessment.id) as {id:number};const assessmentFields=changedFields(before,{pre_score:pre,post_score:postScore,note:text(body.note),pre_date:text(body.preDate)||null,post_date:text(body.postDate)||null,not_completed_reason:reason},['pre_score','post_score','note','pre_date','post_date','not_completed_reason']);logChange(db,'검사 점수','성과검사',saved.id,null,{program_id:scope.programId,run_id:scope.runId,assessment_type_id:assessment.id,assessment_record_id:saved.id,created:!before,changed_fields:assessmentFields,completed:pre!==null&&postScore!==null,note_changed:assessmentFields.includes('note'),reason_present:Boolean(reason)},'검사 입력 상태 저장',user.id,'',requestIp(request));
    } else if (body.action === 'saveSatisfaction') {
      const {scope,application}=outcomeApplication(db,body),applicationId=application.id;
      const score=body.score===''||body.score==null?null:Number(body.score);if(score!==null&&(score<1||score>5))throw new ActionError('만족도는 1~5점이어야 합니다.');const before=db.prepare('SELECT * FROM satisfaction_surveys WHERE application_id=?').get(applicationId) as Record<string,unknown>|undefined,updatedAt=new Date().toISOString();db.prepare(`INSERT INTO satisfaction_surveys (application_id,score,comment,updated_at,survey_version,anonymous) VALUES (?,?,?,?,?,?) ON CONFLICT(application_id) DO UPDATE SET score=excluded.score,comment=excluded.comment,updated_at=excluded.updated_at,survey_version=excluded.survey_version,anonymous=excluded.anonymous`).run(applicationId,score,text(body.comment),updatedAt,text(body.surveyVersion)||'1.0',body.anonymous?1:0);const saved=db.prepare('SELECT id FROM satisfaction_surveys WHERE application_id=?').get(applicationId) as {id:number};logChange(db,'만족도 입력','만족도',saved.id,null,{program_id:scope.programId,run_id:scope.runId,satisfaction_record_id:saved.id,created:!before,score_changed:String(before?.score??'')!==String(score??''),comment_changed:String(before?.comment??'')!==text(body.comment)},'프로그램 만족도 응답 상태 저장',user.id,'',requestIp(request));
    } else if (body.action === 'settings') {
      db.prepare(`INSERT INTO settings (key,value) VALUES ('center_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(text(body.centerName));
      db.prepare(`INSERT INTO settings (key,value) VALUES ('manager_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(text(body.managerName));
    } else if (body.action === 'backup') {
      const source = getDatabasePath();
      const ext = path.extname(source)||'.sqlite';
      const destination = path.join(getBackupDirectory(),`${path.basename(source,ext)}-backup-${today}-${Date.now()}${ext}`);
      await backup(db,destination);
      logChange(db,'백업','데이터베이스',path.basename(destination),null,{backup_file:path.basename(destination)},'로컬 데이터 백업 생성',user.id,'',requestIp(request));
      return Response.json({ ...snapshot(user), backupPath:destination });
    } else if (body.action === 'checkBackup') {
      const result=validateBackup(text(body.path));
      logChange(db,'백업 점검','데이터베이스',path.basename(text(body.path)),null,result,`백업 파일 무결성 점검: ${result.message}`,user.id,'',requestIp(request));
      return Response.json({...snapshot(user),backupCheck:result});
    } else if (body.action === 'restoreBackup') {
      const restorePath=text(body.path);validateBackup(restorePath);
      const source=getDatabasePath(),extension=path.extname(source)||'.sqlite',safetyPath=path.join(getBackupDirectory(),`${path.basename(source,extension)}-backup-before-restore-${today}-${Date.now()}${extension}`);
      await backup(db,safetyPath);
      const candidate=new DatabaseSync(restorePath,{readOnly:true});
      const tables=['settings','participants','programs','program_runs','sessions','applications','attendance','certificates'];
      const candidateTables=new Set((candidate.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {name:string}[]).map(row=>row.name));
      const outcomeTables=['assessment_catalog','program_assessments','assessment_scores','satisfaction_surveys'].filter(table=>candidateTables.has(table));
      const optionalTables=['schedule_events'].filter(table=>candidateTables.has(table));
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM schedule_events;');
        db.exec('DELETE FROM satisfaction_surveys; DELETE FROM assessment_scores; DELETE FROM program_assessments;');
        if(outcomeTables.includes('assessment_catalog'))db.exec('DELETE FROM assessment_catalog');
        for(const table of [...tables].reverse()) db.exec(`DELETE FROM ${table}`);
        for(const table of tables){const sourceRows=candidate.prepare(`SELECT * FROM ${table}`).all() as Record<string,SQLInputValue>[];if(!sourceRows.length)continue;const columns=Object.keys(sourceRows[0]);const insert=db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);for(const row of sourceRows)insert.run(...columns.map(column=>row[column]));}
        for(const table of outcomeTables){const sourceRows=candidate.prepare(`SELECT * FROM ${table}`).all() as Record<string,SQLInputValue>[];if(!sourceRows.length)continue;const columns=Object.keys(sourceRows[0]);const insert=db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);for(const row of sourceRows)insert.run(...columns.map(column=>row[column]));}
        for(const table of optionalTables){const sourceRows=candidate.prepare(`SELECT * FROM ${table}`).all() as Record<string,SQLInputValue>[];if(!sourceRows.length)continue;const columns=Object.keys(sourceRows[0]);const insert=db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);for(const row of sourceRows)insert.run(...columns.map(column=>row[column]));}
        logChange(db,'복원','데이터베이스',path.basename(restorePath),{safety_backup:path.basename(safetyPath)},{restored_from:path.basename(restorePath)},`백업 복원 완료 · 복원 전 안전 백업 생성`,user.id,'',requestIp(request));
        db.exec('COMMIT');
      } catch(error){db.exec('ROLLBACK');throw error;} finally {candidate.close();}
      return Response.json({...snapshot(user),restoreMessage:`복원 완료 · 안전 백업: ${safetyPath}`});
    } else if (body.action === 'certificate') {
      db.prepare('INSERT INTO certificates (participant_id,issued_at,session_count) VALUES (?,?,?)').run(text(body.participantId),today,Number(body.sessionCount));
    } else if (body.action === 'import') {
      if(!Array.isArray(body.rows))throw new ActionError('가져올 행 목록을 올바르게 전송하세요.');
      const input = body.rows as Record<string,unknown>[],operationId=`IMPORT-${randomUUID()}`;
      let processedCount=0,participantCreatedCount=0,applicationCreatedCount=0,applicationUpdatedCount=0,duplicateCount=0,rejectedCount=0;
      const participantUpdatedCount=0;
      for (const item of input.slice(0,1000)) {
        processedCount+=1;
        const name=String(item.name||'').trim(); if(!name){rejectedCount+=1;continue;}
        let participant=db.prepare('SELECT id FROM participants WHERE name=? AND phone=?').get(name,text(item.phone)) as {id:string}|undefined;
        if(!participant){const id=`P-${today.slice(0,4)}-${String(Date.now()+Math.random()).replace(/\D/g,'').slice(-6)}`;db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,name,text(item.gender)||'미입력',Number(item.age||0),text(item.phone),text(item.memberStatus)||'비회원','Excel 가져오기',today);participant={id};participantCreatedCount+=1;}else duplicateCount+=1;
        const program=db.prepare('SELECT id FROM programs WHERE name=?').get(text(item.programName)) as {id:string}|undefined;
        if(!program){rejectedCount+=1;continue;}
        const existingApplication=db.prepare('SELECT id FROM applications WHERE participant_id=? AND program_id=?').get(participant.id,program.id) as {id:number}|undefined,now=new Date().toISOString();
        db.prepare(`INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES (?,?,NULL,?,'신청',?,?) ON CONFLICT(participant_id,program_id) DO UPDATE SET status='신청',status_reason='',status_updated_at=excluded.status_updated_at`).run(participant.id,program.id,text(item.appliedAt)||today,nextQueueNumber(db,program.id),now);
        if(existingApplication)applicationUpdatedCount+=1;else applicationCreatedCount+=1;
      }
      logChange(db,'import_complete','가져오기',operationId,null,{processed_count:processedCount,participant_created_count:participantCreatedCount,participant_updated_count:participantUpdatedCount,application_created_count:applicationCreatedCount,application_updated_count:applicationUpdatedCount,duplicate_count:duplicateCount,rejected_count:rejectedCount},'Excel 참가자 및 신청 가져오기 완료',user.id,'',requestIp(request));
    } else return Response.json({error:'지원하지 않는 작업입니다.'},{status:400});
    if(invalidateCurrentSession)return clearSessionCookie(Response.json({ok:true,loginRequired:true}));
    return Response.json({...snapshot(user),...(responseWarning?{warning:responseWarning}:{}),...(updatedApplicationReason?{updatedApplicationReason}:{})});
  } catch(error) { return error instanceof ActionError?Response.json({error:error.message},{status:400}):internalError(error); }
}

export async function GET(request:Request) { return noStore(await handleGET(request)); }
export async function POST(request:Request) { return noStore(await handlePOST(request)); }
