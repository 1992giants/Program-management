import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRun, getBackupDirectory, getDatabase, getDatabasePath, getStorageInfo, hashPin, verifyPin } from '../../../db/index.ts';
import { attendanceOnlySnapshot, canPerformAction, createAuthSession, getAuthenticatedUser, invalidateAuthSession, type SafeUser } from '../../../lib/security.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function rows(sql:string, ...params:SQLInputValue[]) { return getDatabase().prepare(sql).all(...params); }
const text = (value:unknown) => String(value ?? '');
function nextQueueNumber(db:DatabaseSync,programId:string){return ((db.prepare('SELECT COALESCE(MAX(queue_number),0)+1 AS next FROM applications WHERE program_id=?').get(programId) as {next:number}).next)||1}
function requestIp(request:Request){return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||request.headers.get('x-real-ip')||'local'}

function actorName(db:DatabaseSync) { return (db.prepare(`SELECT value FROM settings WHERE key='manager_name'`).get() as {value:string}|undefined)?.value||'프로그램 담당자'; }
function logChange(db:DatabaseSync, action:string, entityType:string, entityId:string|number, before:unknown, after:unknown, summary:string, requestedActor?:string, reason='',ipAddress='local') {
  const createdAt=new Date().toLocaleString('sv-SE',{timeZone:'Asia/Seoul'});
  db.prepare('INSERT INTO audit_logs (created_at,actor,action,entity_type,entity_id,before_json,after_json,summary,reason,ip_address) VALUES (?,?,?,?,?,?,?,?,?,?)').run(createdAt,requestedActor?.trim()||actorName(db),action,entityType,String(entityId),before?JSON.stringify(before):'',after?JSON.stringify(after):'',summary,reason,ipAddress);
}
function backupFiles() {
  const source=getDatabasePath(), directory=getBackupDirectory(), extension=path.extname(source)||'.sqlite', base=path.basename(source,extension);
  if(!existsSync(directory)) return [];
  return readdirSync(directory).filter(name=>name.startsWith(`${base}-backup-`)&&name.endsWith(extension)).map(name=>{const fullPath=path.join(directory,name),stat=statSync(fullPath);return {name,path:fullPath,size:stat.size,modified_at:stat.mtime.toISOString()}}).sort((a,b)=>b.modified_at.localeCompare(a.modified_at));
}
function validateBackup(filePath:string) {
  const source=getDatabasePath(), resolved=path.resolve(filePath),backupDirectory=path.resolve(getBackupDirectory());
  if(path.dirname(resolved)!==backupDirectory||!path.basename(resolved).startsWith(`${path.basename(source,path.extname(source))}-backup-`)||!existsSync(resolved)) throw new Error('설정된 백업 폴더의 백업 파일만 선택할 수 있습니다.');
  const candidate=new DatabaseSync(resolved,{readOnly:true});
  try { const integrity=candidate.prepare('PRAGMA integrity_check').get() as {integrity_check:string}; const tables=(candidate.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {name:string}[]).map(row=>row.name); const required=['participants','programs','program_runs','sessions','applications','attendance','settings']; const missing=required.filter(name=>!tables.includes(name)); if(integrity.integrity_check!=='ok'||missing.length) throw new Error(`백업 점검 실패${missing.length?`: 누락 테이블 ${missing.join(', ')}`:''}`); return {ok:true,message:'무결성 점검 정상',tables:tables.length}; } finally { candidate.close(); }
}

function snapshot(currentUser?:SafeUser) {
  if(currentUser?.role==='출석 입력 전용')return attendanceOnlySnapshot(getDatabase(),currentUser);
  const settings = Object.fromEntries((rows('SELECT key, value FROM settings') as {key:string;value:string}[]).map(item=>[item.key,item.value]));
  const participants=rows(`SELECT p.*, COUNT(DISTINCT a.id) AS application_count, COUNT(DISTINCT CASE WHEN at.status IN ('참석','보강') THEN at.id END) AS attended_count, MAX(s.session_date) AS last_visit FROM participants p LEFT JOIN applications a ON a.participant_id=p.id LEFT JOIN attendance at ON at.application_id=a.id LEFT JOIN sessions s ON s.id=at.session_id GROUP BY p.id ORDER BY p.created_at DESC`) as Record<string,unknown>[];
  const duplicateMap=new Map<string,Record<string,unknown>[]>();
  for(const participant of participants){const key=`${String(participant.name).trim()}|${String(participant.phone).replace(/\D/g,'')}`;if(!String(participant.phone).replace(/\D/g,''))continue;duplicateMap.set(key,[...(duplicateMap.get(key)||[]),participant]);}
  return {
    settings,
    databasePath: currentUser?.role==='관리자'?getDatabasePath():'로컬 데이터베이스',
    storageInfo: currentUser?.role==='관리자'?getStorageInfo():{architecture:'단일 서버 프로세스',journalMode:'DELETE'},
    participants,
    duplicateGroups:[...duplicateMap.values()].filter(group=>group.length>1),
    programs: rows(`SELECT p.*, COUNT(DISTINCT r.id) AS run_count, COUNT(DISTINCT a.id) AS applicant_count FROM programs p LEFT JOIN program_runs r ON r.program_id=p.id LEFT JOIN applications a ON a.program_id=p.id GROUP BY p.id ORDER BY p.created_at DESC`),
    runs: rows(`SELECT r.*, p.name AS program_name, p.delivery_type, p.session_count, p.capacity, p.manager, COUNT(DISTINCT a.id) AS applicant_count FROM program_runs r JOIN programs p ON p.id=r.program_id LEFT JOIN applications a ON a.run_id=r.id GROUP BY r.id ORDER BY r.start_date DESC, r.round_number DESC`),
    sessions: rows(`SELECT s.*, r.program_id, r.label AS run_label, p.name AS program_name FROM sessions s JOIN program_runs r ON r.id=s.run_id JOIN programs p ON p.id=r.program_id ORDER BY s.session_date DESC, s.session_time`),
    applications: rows(`SELECT a.*, p.name AS participant_name, p.gender, p.age, p.phone, p.member_status, COALESCE(r.label,'차수 미배정') AS run_label, r.round_number, pr.name AS program_name, pr.delivery_type, pr.session_count, r.start_date FROM applications a JOIN participants p ON p.id=a.participant_id JOIN programs pr ON pr.id=a.program_id LEFT JOIN program_runs r ON r.id=a.run_id ORDER BY a.applied_at DESC, a.id DESC`),
    attendance: rows(`SELECT at.*, a.participant_id, a.run_id, p.name AS participant_name, s.session_number, s.session_date, s.session_time, pr.name AS program_name, r.label AS run_label FROM attendance at JOIN applications a ON a.id=at.application_id JOIN participants p ON p.id=a.participant_id JOIN sessions s ON s.id=at.session_id JOIN program_runs r ON r.id=a.run_id JOIN programs pr ON pr.id=a.program_id ORDER BY s.session_date DESC`),
    certificates: rows(`SELECT c.*, p.name AS participant_name FROM certificates c JOIN participants p ON p.id=c.participant_id ORDER BY c.issued_at DESC`),
    auditLogs: currentUser?.role==='출석 입력 전용'?[]:rows(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300`),
    backupFiles: currentUser?.role==='관리자'?backupFiles():[],
    users: currentUser?.role==='관리자'?rows(`SELECT id,username,display_name,role,active,created_at,failed_attempts,locked_until,last_login_at,pin_changed_at,must_change_pin FROM staff_users ORDER BY active DESC, display_name`):[],
    currentUser: currentUser||null,
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

export async function GET(request:Request) {
  try { const db=getDatabase(),user=getAuthenticatedUser(request,db);if(!user)return Response.json({error:'로그인이 필요합니다.',loginRequired:true},{status:401});return Response.json(snapshot(user)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : '로컬 데이터 파일을 열지 못했습니다.' }, { status:500 }); }
}

export async function POST(request:Request) {
  try {
    const body = await request.json() as Record<string,unknown>;
    const db = getDatabase();
    const today = new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Seoul' });
    if(body.action==='login'){
      const username=text(body.username).trim().toLowerCase(),now=new Date(),nowIso=now.toISOString(),ip=requestIp(request),user=db.prepare('SELECT id,username,display_name,role,active,pin_hash,failed_attempts,locked_until,must_change_pin,last_login_at FROM staff_users WHERE username=?').get(username) as (SafeUser&{pin_hash:string;failed_attempts:number;locked_until:string|null})|undefined;
      if(user?.locked_until&&new Date(user.locked_until)>now)return Response.json({error:`로그인 실패가 반복되어 계정이 잠겼습니다. ${new Date(user.locked_until).toLocaleTimeString('ko-KR')} 이후 다시 시도하세요.`},{status:423});
      if(!user||!user.active||!verifyPin(username,text(body.pin),user.pin_hash)){
        if(user){const failures=(user.failed_attempts||0)+1,lockedUntil=failures>=5?new Date(Date.now()+15*60*1000).toISOString():null;db.prepare('UPDATE staff_users SET failed_attempts=?,locked_until=? WHERE id=?').run(failures,lockedUntil,user.id);logChange(db,'로그인 실패','사용자',user.id,null,{failedAttempts:failures,lockedUntil},`${username} 로그인 실패`,username,'PIN 불일치',ip)}
        return Response.json({error:'계정 또는 PIN이 올바르지 않습니다.'},{status:401});
      }
      if(!user.pin_hash.startsWith('scrypt$')||user.pin_hash.split('$').length<3)db.prepare('UPDATE staff_users SET pin_hash=? WHERE id=?').run(hashPin(username,text(body.pin)),user.id);
      db.prepare('UPDATE staff_users SET failed_attempts=0,locked_until=NULL,last_login_at=? WHERE id=?').run(nowIso,user.id);
      const {token}=createAuthSession(db,user.id,ip);const safeUser:SafeUser={id:user.id,username:user.username,display_name:user.display_name,role:user.role,active:user.active,must_change_pin:user.must_change_pin,last_login_at:nowIso};logChange(db,'로그인','사용자',user.id,null,{role:user.role},`${user.display_name} 로그인`,user.display_name,'',ip);return Response.json({...snapshot(safeUser),authToken:token});
    }
    const user=getAuthenticatedUser(request,db);
    if(!user)return Response.json({error:'로그인이 만료되었습니다.',loginRequired:true},{status:401});
    const action=text(body.action);if(user.must_change_pin&&!['changeMyPin','recordAccess','logout'].includes(action))return Response.json({error:'관리자가 발급한 임시 PIN을 먼저 변경하세요.'},{status:403});if(!canPerformAction(user,action))return Response.json({error:`${user.role} 권한으로는 이 작업을 수행할 수 없습니다.`},{status:403});
    body.actor=user.display_name;
    let responseWarning='';
    if(body.action==='logout'){
      invalidateAuthSession(request,db);
      logChange(db,'로그아웃','사용자',user.id,null,null,`${user.display_name} 로그아웃`,user.display_name,'',requestIp(request));
      return Response.json({ok:true});
    } else if (body.action === 'createParticipant') {
      const duplicate=db.prepare(`SELECT id,name,phone FROM participants WHERE TRIM(name)=TRIM(?) AND REPLACE(REPLACE(phone,'-',''),' ','')=REPLACE(REPLACE(?,'-',''),' ','')`).get(text(body.name),text(body.phone)) as {id:string;name:string;phone:string}|undefined;
      if(duplicate) return Response.json({error:`동일한 이름과 연락처의 참가자(${duplicate.id})가 이미 있습니다. 기존 참가자를 확인하거나 중복 병합을 이용하세요.`,duplicate},{status:409});
      const id = `P-${today.slice(0,4)}-${String(Date.now()).slice(-6)}`;
      db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,text(body.name),text(body.gender),Number(body.age||0),text(body.phone),text(body.memberStatus),text(body.note),today);
      const programIds = Array.isArray(body.programIds) ? body.programIds.map(text) : [];
      const insertApplication = db.prepare(`INSERT OR IGNORE INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES (?,?,NULL,?,'신청',?,?)`);
      for (const programId of programIds) insertApplication.run(id,programId,today,nextQueueNumber(db,programId),today);
      logChange(db,'등록','참가자',id,null,db.prepare('SELECT * FROM participants WHERE id=?').get(id),`${text(body.name)} 참가자 등록`,user.display_name,'',requestIp(request));
    } else if (body.action === 'updateParticipant') {
      const before=db.prepare('SELECT * FROM participants WHERE id=?').get(text(body.id));
      const duplicate=db.prepare(`SELECT id,name,phone FROM participants WHERE id<>? AND TRIM(name)=TRIM(?) AND REPLACE(REPLACE(phone,'-',''),' ','')=REPLACE(REPLACE(?,'-',''),' ','')`).get(text(body.id),text(body.name),text(body.phone)) as {id:string;name:string;phone:string}|undefined;
      if(duplicate) return Response.json({error:`수정하려는 정보가 기존 참가자(${duplicate.id})와 중복됩니다. 중복 병합을 이용하세요.`,duplicate},{status:409});
      db.prepare('UPDATE participants SET name=?,gender=?,age=?,phone=?,member_status=?,note=? WHERE id=?').run(text(body.name),text(body.gender),Number(body.age||0),text(body.phone),text(body.memberStatus),text(body.note),text(body.id));
      logChange(db,'수정','참가자',text(body.id),before,db.prepare('SELECT * FROM participants WHERE id=?').get(text(body.id)),`${text(body.name)} 기본정보 수정`,user.display_name,'',requestIp(request));
    } else if (body.action === 'createProgram') {
      const id = `PRG-${String(Date.now()).slice(-6)}`;
      const capacity = body.deliveryType === '1:1' ? 1 : Number(body.capacity||10);
      db.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,text(body.name),text(body.category),text(body.deliveryType),Number(body.sessionCount),text(body.recurrence),text(body.location),text(body.manager),capacity,'운영 중',today);
      createRun(db,id,1,String(body.runLabel||'1차'),String(body.startDate),String(body.time));
    } else if (body.action === 'createRun') {
      const last = db.prepare('SELECT COALESCE(MAX(round_number),0) AS max_round FROM program_runs WHERE program_id=?').get(text(body.programId)) as {max_round:number};
      createRun(db,String(body.programId),last.max_round+1,String(body.label),String(body.startDate),String(body.time));
    } else if (body.action === 'updateProgram') {
      const capacity = body.deliveryType === '1:1' ? 1 : Number(body.capacity||10);
      db.prepare('UPDATE programs SET name=?,category=?,delivery_type=?,location=?,manager=?,capacity=?,status=? WHERE id=?').run(text(body.name),text(body.category),text(body.deliveryType),text(body.location),text(body.manager),capacity,text(body.status),text(body.id));
      db.prepare('UPDATE sessions SET location=? WHERE run_id IN (SELECT id FROM program_runs WHERE program_id=?)').run(text(body.location),text(body.id));
    } else if (body.action === 'updateRunStatus') {
      const statuses=['모집 예정','모집 중','모집 마감','참가자 확정','진행 중','종료','취소'],status=text(body.status),id=text(body.id),before=db.prepare('SELECT * FROM program_runs WHERE id=?').get(id);
      if(!before||!statuses.includes(status))throw new Error('올바른 차수 운영 상태를 선택하세요.');
      const reason=text(body.reason).trim();if(status==='취소'&&!reason)throw new Error('차수 취소 사유를 입력하세요.');const now=new Date().toISOString(),closed=['종료','취소'].includes(status);db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE program_runs SET status=?,closed_at=?,closed_by=? WHERE id=?').run(status,closed?now:null,closed?user.display_name:null,id);if(status==='진행 중')db.prepare(`UPDATE applications SET status='참가중',status_updated_at=? WHERE run_id=? AND status IN ('신청','선정검토','참가대기')`).run(now,id);if(status==='종료')db.prepare(`UPDATE applications SET status='참가완료',status_updated_at=? WHERE run_id=? AND status='참가중'`).run(now,id);if(status==='취소')db.prepare(`UPDATE applications SET status='취소',status_reason=?,status_updated_at=? WHERE run_id=? AND status NOT IN ('참가완료','중도탈락','취소')`).run(reason,now,id);logChange(db,'차수 상태','차수',id,before,db.prepare('SELECT * FROM program_runs WHERE id=?').get(id),`차수 상태를 ${status}(으)로 변경`,user.display_name,reason,requestIp(request));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    } else if (body.action === 'updateSession') {
      const before=db.prepare('SELECT * FROM sessions WHERE id=?').get(text(body.id));
      db.prepare('UPDATE sessions SET session_date=?,session_time=?,location=? WHERE id=?').run(text(body.sessionDate),text(body.sessionTime),text(body.location),text(body.id));
      logChange(db,'일정 수정','회기',text(body.id),before,db.prepare('SELECT * FROM sessions WHERE id=?').get(text(body.id)),'프로그램 회기 일정 수정',user.display_name);
    } else if (body.action === 'createScheduleEvent') {
      const participantId=text(body.participantId),title=text(body.title).trim(),eventDate=text(body.eventDate),eventType=text(body.eventType)||'상담',color=text(body.color)||'green',allDay=body.allDay?1:0,startTime=allDay?'':text(body.startTime),endTime=allDay?'':text(body.endTime),recurrence=text(body.recurrence)||'1회',deliveryMode=text(body.deliveryMode)||'대면';
      if(!participantId||!title||!/^\d{4}-\d{2}-\d{2}$/.test(eventDate))throw new Error('참가자, 일정 제목과 날짜를 입력하세요.');
      if(!db.prepare('SELECT id FROM participants WHERE id=?').get(participantId))throw new Error('참가자를 찾을 수 없습니다.');
      if(!allDay&&(!startTime||!endTime||endTime<=startTime))throw new Error('종료시간은 시작시간보다 늦어야 합니다.');
      if(!['상담','프로그램','기타'].includes(eventType))throw new Error('올바른 프로그램 종류를 선택하세요.');
      if(!['green','orange','blue','purple','gray'].includes(color))throw new Error('올바른 일정 색상을 선택하세요.');
      const id=`EVT-${String(Date.now()).slice(-10)}`,createdAt=new Date().toISOString();
      db.prepare('INSERT INTO schedule_events (id,event_type,color,participant_id,title,event_date,all_day,start_time,end_time,recurrence,delivery_mode,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,eventType,color,participantId,title,eventDate,allDay,startTime,endTime,recurrence,deliveryMode,createdAt);
      logChange(db,'일정 등록','일정',id,null,db.prepare('SELECT * FROM schedule_events WHERE id=?').get(id),`${eventDate} ${title} 일정 등록`,user.display_name);
    } else if (body.action === 'apply') {
      const programId=text(body.programId);db.prepare(`INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES (?,?,NULL,?,'신청',?,?) ON CONFLICT(participant_id,program_id) DO UPDATE SET status='신청',status_reason='',status_updated_at=excluded.status_updated_at`).run(text(body.participantId),programId,today,nextQueueNumber(db,programId),today);
    } else if (body.action === 'assignRun') {
      const run = db.prepare('SELECT r.program_id,r.status,p.capacity FROM program_runs r JOIN programs p ON p.id=r.program_id WHERE r.id=?').get(text(body.runId)) as {program_id:string;status:string;capacity:number}|undefined;
      const application = db.prepare('SELECT program_id FROM applications WHERE id=?').get(Number(body.applicationId)) as {program_id:string}|undefined;
      if (!run || !application || run.program_id!==application.program_id) throw new Error('같은 프로그램의 차수만 배정할 수 있습니다.');
      if(['종료','취소'].includes(run.status))throw new Error('종료·취소된 차수에는 참가자를 배정할 수 없습니다.');
      const assigned=db.prepare(`SELECT COUNT(*) AS count FROM applications WHERE run_id=? AND id<>? AND status NOT IN ('취소','중도탈락')`).get(text(body.runId),Number(body.applicationId)) as {count:number};
      if(assigned.count>=run.capacity)responseWarning=`정원 ${run.capacity}명을 초과합니다. 경고 상태로 배정했습니다.`;
      db.prepare(`UPDATE applications SET run_id=?, status=CASE WHEN status IN ('신청','선정검토') THEN '참가대기' ELSE status END,assigned_at=?,status_updated_at=? WHERE id=?`).run(text(body.runId),new Date().toISOString(),new Date().toISOString(),Number(body.applicationId));
    } else if (body.action === 'applyToRun') {
      const run = db.prepare('SELECT r.program_id,r.status,p.capacity FROM program_runs r JOIN programs p ON p.id=r.program_id WHERE r.id=?').get(text(body.runId)) as {program_id:string;status:string;capacity:number}|undefined;
      if (!run) throw new Error('차수를 찾을 수 없습니다.');
      if(['종료','취소'].includes(run.status))throw new Error('종료·취소된 차수에는 신청자를 추가할 수 없습니다.');
      const assigned = db.prepare(`SELECT COUNT(*) AS count FROM applications WHERE run_id=? AND status NOT IN ('취소','중도탈락')`).get(text(body.runId)) as {count:number};
      if (assigned.count>=run.capacity) responseWarning=`정원 ${run.capacity}명을 초과합니다. 경고 상태로 신청자를 추가했습니다.`;
      db.prepare(`INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at,assigned_at) VALUES (?,?,?,?,'참가대기',?,?,?) ON CONFLICT(participant_id,program_id) DO UPDATE SET run_id=excluded.run_id,status='참가대기',assigned_at=excluded.assigned_at,status_updated_at=excluded.status_updated_at`).run(text(body.participantId),run.program_id,text(body.runId),today,nextQueueNumber(db,run.program_id),new Date().toISOString(),new Date().toISOString());
    } else if (body.action === 'applicationStatus') {
      const id=Number(body.id),status=text(body.status),reason=text(body.reason).trim(),statuses=['신청','선정검토','참가대기','참가중','참가완료','중도탈락','취소'],before=db.prepare('SELECT * FROM applications WHERE id=?').get(id);
      if(!before||!statuses.includes(status))throw new Error('올바른 신청 상태를 선택하세요.');
      if(['중도탈락','취소'].includes(status)&&!reason)throw new Error(`${status} 사유를 입력하세요.`);
      db.prepare('UPDATE applications SET status=?,status_reason=?,status_updated_at=? WHERE id=?').run(status,reason,new Date().toISOString(),id);
      logChange(db,'상태 변경','신청',id,before,db.prepare('SELECT * FROM applications WHERE id=?').get(id),`신청 현황을 ${status}(으)로 변경`,user.display_name,reason,requestIp(request));
    } else if (body.action === 'attendance') {
      const sessionId=text(body.sessionId),applicationId=Number(body.applicationId),status=text(body.status),noteText=text(body.note).trim(),validStatuses=['참석','결석','보강','취소','노쇼','기타','미입력'];if(!validStatuses.includes(status))throw new Error('올바른 출석 상태를 선택하세요.');if(['결석','취소','노쇼','기타'].includes(status)&&!noteText)throw new Error(`${status} 사유나 연락 결과를 입력하세요.`);const sessionState=db.prepare('SELECT run_id,attendance_status FROM sessions WHERE id=?').get(sessionId) as {run_id:string;attendance_status:string}|undefined;if(!sessionState)throw new Error('회기를 찾을 수 없습니다.');if(sessionState.attendance_status==='마감')throw new Error('마감된 회기의 출석은 수정할 수 없습니다. 관리자가 회기를 다시 열어야 합니다.');const application=db.prepare('SELECT run_id FROM applications WHERE id=?').get(applicationId) as {run_id:string|null}|undefined;if(!application||application.run_id!==sessionState.run_id)throw new Error('해당 차수에 배정된 참가자만 출석을 입력할 수 있습니다.');const makeupFor=text(body.makeupForSessionId);if(makeupFor&&!db.prepare('SELECT id FROM sessions WHERE id=?').get(makeupFor))throw new Error('보강 대상 회기를 찾을 수 없습니다.');
      const before=db.prepare('SELECT * FROM attendance WHERE application_id=? AND session_id=?').get(applicationId,sessionId);db.prepare(`INSERT INTO attendance (application_id,session_id,status,note,contacted_at,makeup_for_session_id) VALUES (?,?,?,?,?,?) ON CONFLICT(application_id,session_id) DO UPDATE SET status=excluded.status,note=excluded.note,contacted_at=excluded.contacted_at,makeup_for_session_id=excluded.makeup_for_session_id`).run(applicationId,sessionId,status,noteText,text(body.contactedAt)||null,makeupFor||null);const after=db.prepare('SELECT * FROM attendance WHERE application_id=? AND session_id=?').get(applicationId,sessionId);logChange(db,'출석 입력','출석',`${applicationId}:${sessionId}`,before,after,`출석 상태를 ${status}(으)로 변경`,user.display_name,noteText,requestIp(request));
    } else if (body.action === 'attendanceBulk') {
      const applicationIds=[...new Set(Array.isArray(body.applicationIds)?body.applicationIds.map(Number).filter(Number.isFinite):[])];
      const sessionId=text(body.sessionId),status=text(body.status);
      if(!['참석','결석','보강','취소','노쇼','기타','미입력'].includes(status))throw new Error('올바른 출석 상태를 선택하세요.');
      if(!applicationIds.length)throw new Error('출석을 입력할 참가자를 선택하세요.');
      const sessionState=db.prepare('SELECT run_id,attendance_status FROM sessions WHERE id=?').get(sessionId) as {run_id:string;attendance_status:string}|undefined;
      if(!sessionState)throw new Error('회기를 찾을 수 없습니다.');
      if(sessionState.attendance_status==='마감')throw new Error('마감된 회기의 출석은 수정할 수 없습니다.');
      const selectedApplications=db.prepare(`SELECT id,run_id FROM applications WHERE id IN (${applicationIds.map(()=>'?').join(',')})`).all(...applicationIds) as {id:number;run_id:string|null}[];
      if(selectedApplications.length!==applicationIds.length)throw new Error('존재하지 않는 신청 기록이 포함되어 있습니다.');
      if(selectedApplications.some(application=>application.run_id!==sessionState.run_id))throw new Error('해당 차수에 배정된 참가자만 일괄 출석을 입력할 수 있습니다.');
      db.exec('BEGIN IMMEDIATE');
      try { for(const applicationId of applicationIds){const before=db.prepare('SELECT * FROM attendance WHERE application_id=? AND session_id=?').get(applicationId,sessionId);db.prepare(`INSERT INTO attendance (application_id,session_id,status,note) VALUES (?,?,?,'') ON CONFLICT(application_id,session_id) DO UPDATE SET status=excluded.status`).run(applicationId,sessionId,status);logChange(db,'출석 일괄 입력','출석',`${applicationId}:${sessionId}`,before,db.prepare('SELECT * FROM attendance WHERE application_id=? AND session_id=?').get(applicationId,sessionId),`일괄 출석 상태를 ${status}(으)로 변경`,user.display_name,'',requestIp(request));}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    } else if (body.action === 'closeAttendanceSession') {
      const sessionId=text(body.sessionId),before=db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as Record<string,unknown>|undefined;if(!before)throw new Error('회기를 찾을 수 없습니다.');
      const active=(db.prepare(`SELECT COUNT(*) AS count FROM applications WHERE run_id=? AND status NOT IN ('취소','중도탈락')`).get(String(before.run_id)) as {count:number}).count,entered=(db.prepare(`SELECT COUNT(*) AS count FROM attendance at JOIN applications a ON a.id=at.application_id WHERE at.session_id=? AND a.run_id=? AND a.status NOT IN ('취소','중도탈락') AND at.status!='미입력'`).get(sessionId,String(before.run_id)) as {count:number}).count;
      if(entered<active)throw new Error(`출석 미입력 ${active-entered}명이 있어 마감할 수 없습니다.`);
      db.prepare(`UPDATE sessions SET attendance_status='마감',attendance_closed_at=?,attendance_closed_by=? WHERE id=?`).run(new Date().toISOString(),user.display_name,sessionId);logChange(db,'출석 마감','회기',sessionId,before,db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId),'회기 출석 입력 마감',user.display_name,'',requestIp(request));
    } else if (body.action === 'reopenAttendanceSession') {
      const sessionId=text(body.sessionId),reason=text(body.reason).trim(),before=db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);if(!before)throw new Error('회기를 찾을 수 없습니다.');if(!reason)throw new Error('마감 해제 사유를 입력하세요.');db.prepare(`UPDATE sessions SET attendance_status='작성 중',attendance_closed_at=NULL,attendance_closed_by=NULL,reopen_reason=? WHERE id=?`).run(reason,sessionId);logChange(db,'출석 마감 해제','회기',sessionId,before,db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId),'회기 출석 마감 해제',user.display_name,reason,requestIp(request));
    } else if (body.action === 'mergeParticipants') {
      const keepId=text(body.keepId),mergeId=text(body.mergeId);
      if(!keepId||!mergeId||keepId===mergeId) throw new Error('병합할 서로 다른 참가자를 선택하세요.');
      const keep=db.prepare('SELECT * FROM participants WHERE id=?').get(keepId) as Record<string,unknown>|undefined,source=db.prepare('SELECT * FROM participants WHERE id=?').get(mergeId) as Record<string,unknown>|undefined;
      if(!keep||!source) throw new Error('병합할 참가자를 찾을 수 없습니다.');
      if(String(keep.name).trim()!==String(source.name).trim()||String(keep.phone).replace(/\D/g,'')!==String(source.phone).replace(/\D/g,'')) throw new Error('이름과 연락처가 같은 중복 참가자만 병합할 수 있습니다.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const sourceApps=db.prepare('SELECT * FROM applications WHERE participant_id=?').all(mergeId) as {id:number;program_id:string}[];
        for(const sourceApp of sourceApps){const targetApp=db.prepare('SELECT id FROM applications WHERE participant_id=? AND program_id=?').get(keepId,sourceApp.program_id) as {id:number}|undefined;if(targetApp){const sourceAttendance=db.prepare('SELECT * FROM attendance WHERE application_id=?').all(sourceApp.id) as {session_id:string;status:string;note:string}[];for(const attendance of sourceAttendance){const existing=db.prepare('SELECT status FROM attendance WHERE application_id=? AND session_id=?').get(targetApp.id,attendance.session_id) as {status:string}|undefined;if(!existing)db.prepare('INSERT INTO attendance (application_id,session_id,status,note) VALUES (?,?,?,?)').run(targetApp.id,attendance.session_id,attendance.status,attendance.note);else if(existing.status==='미입력'&&attendance.status!=='미입력')db.prepare('UPDATE attendance SET status=?,note=? WHERE application_id=? AND session_id=?').run(attendance.status,attendance.note,targetApp.id,attendance.session_id);}db.prepare('DELETE FROM applications WHERE id=?').run(sourceApp.id);}else db.prepare('UPDATE applications SET participant_id=? WHERE id=?').run(keepId,sourceApp.id);}
        db.prepare('UPDATE certificates SET participant_id=? WHERE participant_id=?').run(keepId,mergeId);
        const mergedNote=[text(keep.note),text(source.note)].filter(Boolean).filter((value,index,array)=>array.indexOf(value)===index).join('\n[병합 메모] ');
        db.prepare('UPDATE participants SET note=? WHERE id=?').run(mergedNote,keepId);
        db.prepare('DELETE FROM participants WHERE id=?').run(mergeId);
        logChange(db,'병합','참가자',keepId,{유지:keep,병합:source},db.prepare('SELECT * FROM participants WHERE id=?').get(keepId),`${text(source.name)} ${mergeId} 기록을 ${keepId}로 병합`,user.display_name,'',requestIp(request));
        db.exec('COMMIT');
      } catch(error){db.exec('ROLLBACK');throw error;}
    } else if (body.action === 'createUser') {
      const username=text(body.username).trim().toLowerCase(),pin=text(body.pin),role=text(body.role);if(!username||pin.length<6||/^([0-9])\1+$/.test(pin))throw new Error('계정명과 반복 숫자가 아닌 6자리 이상 PIN을 입력하세요.');if(!['관리자','일반 담당자','출석 입력 전용'].includes(role))throw new Error('올바른 권한을 선택하세요.');const id=`USR-${String(Date.now()).slice(-8)}`,now=new Date().toISOString();db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,pin_changed_at,must_change_pin) VALUES (?,?,?,?,?,1,?,?,1)').run(id,username,text(body.displayName),hashPin(username,pin),role,today,now);logChange(db,'계정 등록','사용자',id,null,{username,displayName:text(body.displayName),role},`${text(body.displayName)} 계정 생성`,user.display_name,'',requestIp(request));
    } else if (body.action === 'updateUser') {
      const target=db.prepare('SELECT * FROM staff_users WHERE id=?').get(text(body.id)) as Record<string,unknown>|undefined;if(!target)throw new Error('사용자를 찾을 수 없습니다.');const nextRole=text(body.role),nextActive=body.active?1:0;if(target.role==='관리자'&&(nextRole!=='관리자'||!nextActive)){const admins=db.prepare(`SELECT COUNT(*) AS count FROM staff_users WHERE role='관리자' AND active=1`).get() as {count:number};if(admins.count<=1)throw new Error('마지막 관리자는 권한을 변경하거나 사용 중지할 수 없습니다.');}const pin=text(body.pin);if(pin&&(pin.length<6||/^([0-9])\1+$/.test(pin)))throw new Error('PIN은 반복 숫자가 아닌 6자리 이상이어야 합니다.');if(pin)db.prepare('UPDATE staff_users SET display_name=?,role=?,active=?,pin_hash=?,pin_changed_at=?,must_change_pin=1,failed_attempts=0,locked_until=NULL WHERE id=?').run(text(body.displayName),nextRole,nextActive,hashPin(String(target.username),pin),new Date().toISOString(),text(body.id));else db.prepare('UPDATE staff_users SET display_name=?,role=?,active=? WHERE id=?').run(text(body.displayName),nextRole,nextActive,text(body.id));logChange(db,'계정 수정','사용자',text(body.id),{display_name:target.display_name,role:target.role,active:target.active},{display_name:text(body.displayName),role:nextRole,active:nextActive},`${text(body.displayName)} 계정 수정`,user.display_name,'',requestIp(request));
    } else if (body.action === 'changeMyPin') {
      const current=text(body.currentPin),next=text(body.newPin),account=db.prepare('SELECT username,pin_hash FROM staff_users WHERE id=?').get(user.id) as {username:string;pin_hash:string}|undefined;if(!account||!verifyPin(account.username,current,account.pin_hash))throw new Error('현재 PIN이 올바르지 않습니다.');if(next.length<6||/^([0-9])\1+$/.test(next))throw new Error('새 PIN은 반복 숫자가 아닌 6자리 이상으로 입력하세요.');db.prepare('UPDATE staff_users SET pin_hash=?,pin_changed_at=?,must_change_pin=0 WHERE id=?').run(hashPin(account.username,next),new Date().toISOString(),user.id);db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token<>?').run(user.id,request.headers.get('authorization')?.replace(/^Bearer\s+/i,'')||'');logChange(db,'PIN 변경','사용자',user.id,null,{pinChanged:true},`${user.display_name} PIN 변경`,user.display_name,'',requestIp(request));return Response.json(snapshot({...user,must_change_pin:0}));
    } else if (body.action === 'recordAccess') {
      logChange(db,text(body.accessAction)||'조회','접근',text(body.target)||'화면',null,null,text(body.summary)||'화면 조회',user.display_name,'',requestIp(request));
      return Response.json({ok:true});
    } else if (body.action === 'addAssessmentType') {
      const name=text(body.name).trim(),min=Number(body.minScore),max=Number(body.maxScore),version=text(body.version)||'1.0',description=text(body.description);if(!name||!Number.isFinite(min)||!Number.isFinite(max)||max<=min)throw new Error('검사명과 올바른 점수 범위를 입력하세요.');const id=`ASM-${String(Date.now()).slice(-8)}`;db.prepare('INSERT INTO assessment_catalog (id,name,min_score,max_score,active,created_at,version,description) VALUES (?,?,?,?,1,?,?,?)').run(id,name,min,max,today,version,description);logChange(db,'검사 추가','검사',id,null,{name,min,max,version},`${name} 검사 항목 추가`,user.display_name);
    } else if (body.action === 'setAssessmentActive') {
      db.prepare('UPDATE assessment_catalog SET active=? WHERE id=?').run(body.active?1:0,text(body.id));logChange(db,'검사 상태 변경','검사',text(body.id),null,{active:body.active?1:0},`검사 항목 ${body.active?'사용':'사용 중지'}`,user.display_name);
    } else if (body.action === 'setProgramAssessments') {
      const programId=text(body.programId),ids=Array.isArray(body.assessmentIds)?body.assessmentIds.map(text):[];db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM program_assessments WHERE program_id=?').run(programId);const insert=db.prepare('INSERT INTO program_assessments (program_id,assessment_id,sort_order) VALUES (?,?,?)');ids.forEach((id,index)=>insert.run(programId,id,index));logChange(db,'검사 구성','프로그램',programId,null,{assessmentIds:ids},`프로그램 검사 ${ids.length}개 구성`,user.display_name);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    } else if (body.action === 'saveAssessmentScore') {
      const assessment=db.prepare('SELECT min_score,max_score FROM assessment_catalog WHERE id=?').get(text(body.assessmentId)) as {min_score:number;max_score:number}|undefined;if(!assessment)throw new Error('검사 항목을 찾을 수 없습니다.');const pre=body.preScore===''||body.preScore==null?null:Number(body.preScore),postScore=body.postScore===''||body.postScore==null?null:Number(body.postScore),reason=text(body.notCompletedReason).trim();for(const value of [pre,postScore])if(value!==null&&(value<assessment.min_score||value>assessment.max_score))throw new Error(`점수는 ${assessment.min_score}~${assessment.max_score} 범위여야 합니다.`);if(pre===null&&postScore===null&&!reason)throw new Error('점수를 입력하거나 미실시 사유를 입력하세요.');const before=db.prepare('SELECT * FROM assessment_scores WHERE application_id=? AND assessment_id=?').get(Number(body.applicationId),text(body.assessmentId));const updatedAt=new Date().toISOString();db.prepare(`INSERT INTO assessment_scores (application_id,assessment_id,pre_score,post_score,note,updated_at,pre_date,post_date,not_completed_reason,assessor) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(application_id,assessment_id) DO UPDATE SET pre_score=excluded.pre_score,post_score=excluded.post_score,note=excluded.note,updated_at=excluded.updated_at,pre_date=excluded.pre_date,post_date=excluded.post_date,not_completed_reason=excluded.not_completed_reason,assessor=excluded.assessor`).run(Number(body.applicationId),text(body.assessmentId),pre,postScore,text(body.note),updatedAt,text(body.preDate)||null,text(body.postDate)||null,reason,user.display_name);logChange(db,'검사 점수','성과검사',`${body.applicationId}:${text(body.assessmentId)}`,before,db.prepare('SELECT * FROM assessment_scores WHERE application_id=? AND assessment_id=?').get(Number(body.applicationId),text(body.assessmentId)),'사전·사후 검사 점수 저장',user.display_name,reason,requestIp(request));
    } else if (body.action === 'saveSatisfaction') {
      const score=body.score===''||body.score==null?null:Number(body.score);if(score!==null&&(score<1||score>5))throw new Error('만족도는 1~5점이어야 합니다.');const before=db.prepare('SELECT * FROM satisfaction_surveys WHERE application_id=?').get(Number(body.applicationId)),updatedAt=new Date().toISOString();db.prepare(`INSERT INTO satisfaction_surveys (application_id,score,comment,updated_at,survey_version,anonymous) VALUES (?,?,?,?,?,?) ON CONFLICT(application_id) DO UPDATE SET score=excluded.score,comment=excluded.comment,updated_at=excluded.updated_at,survey_version=excluded.survey_version,anonymous=excluded.anonymous`).run(Number(body.applicationId),score,text(body.comment),updatedAt,text(body.surveyVersion)||'1.0',body.anonymous?1:0);logChange(db,'만족도 입력','만족도',Number(body.applicationId),before,db.prepare('SELECT * FROM satisfaction_surveys WHERE application_id=?').get(Number(body.applicationId)),'프로그램 만족도 저장',user.display_name,'',requestIp(request));
    } else if (body.action === 'settings') {
      db.prepare(`INSERT INTO settings (key,value) VALUES ('center_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(text(body.centerName));
      db.prepare(`INSERT INTO settings (key,value) VALUES ('manager_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(text(body.managerName));
    } else if (body.action === 'backup') {
      const source = getDatabasePath();
      const ext = path.extname(source)||'.sqlite';
      const destination = path.join(getBackupDirectory(),`${path.basename(source,ext)}-backup-${today}-${Date.now()}${ext}`);
      await backup(db,destination);
      logChange(db,'백업','데이터베이스',path.basename(destination),null,{path:destination},'로컬 데이터 백업 생성',user.display_name,'',requestIp(request));
      return Response.json({ ...snapshot(user), backupPath:destination });
    } else if (body.action === 'checkBackup') {
      const result=validateBackup(text(body.path));
      logChange(db,'백업 점검','데이터베이스',path.basename(text(body.path)),null,result,`백업 파일 무결성 점검: ${result.message}`,user.display_name,'',requestIp(request));
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
        logChange(db,'복원','데이터베이스',path.basename(restorePath),{safetyBackup:safetyPath},{restoredFrom:restorePath},`백업 복원 완료 · 복원 전 안전 백업 생성`,user.display_name,'',requestIp(request));
        db.exec('COMMIT');
      } catch(error){db.exec('ROLLBACK');throw error;} finally {candidate.close();}
      return Response.json({...snapshot(user),restoreMessage:`복원 완료 · 안전 백업: ${safetyPath}`});
    } else if (body.action === 'certificate') {
      db.prepare('INSERT INTO certificates (participant_id,issued_at,session_count) VALUES (?,?,?)').run(text(body.participantId),today,Number(body.sessionCount));
    } else if (body.action === 'import') {
      const input = Array.isArray(body.rows)?body.rows as Record<string,unknown>[]:[];
      for (const item of input.slice(0,1000)) {
        const name=String(item.name||'').trim(); if(!name) continue;
        let participant=db.prepare('SELECT id FROM participants WHERE name=? AND phone=?').get(name,text(item.phone)) as {id:string}|undefined;
        if(!participant){const id=`P-${today.slice(0,4)}-${String(Date.now()+Math.random()).replace(/\D/g,'').slice(-6)}`;db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,name,text(item.gender)||'미입력',Number(item.age||0),text(item.phone),text(item.memberStatus)||'비회원','Excel 가져오기',today);participant={id};}
        const program=db.prepare('SELECT id FROM programs WHERE name=?').get(text(item.programName)) as {id:string}|undefined;
        if(program){const now=new Date().toISOString();db.prepare(`INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES (?,?,NULL,?,'신청',?,?) ON CONFLICT(participant_id,program_id) DO UPDATE SET status='신청',status_reason='',status_updated_at=excluded.status_updated_at`).run(participant.id,program.id,text(item.appliedAt)||today,nextQueueNumber(db,program.id),now);}
      }
    } else return Response.json({error:'지원하지 않는 작업입니다.'},{status:400});
    return Response.json({...snapshot(user),...(responseWarning?{warning:responseWarning}:{})});
  } catch(error) { return Response.json({error:error instanceof Error?error.message:'저장하지 못했습니다.'},{status:500}); }
}
