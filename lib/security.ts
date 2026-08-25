import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type StaffRole='관리자'|'일반 담당자'|'출석 입력 전용';
export type SafeUser={id:string;username:string;display_name:string;role:string;active:number;must_change_pin?:number;last_login_at?:string|null};

const ADMIN_ACTIONS=[
  'createParticipant','updateParticipant','createProgram','createRun','updateProgram','updateRunStatus','updateSession','createScheduleEvent',
  'apply','assignRun','applyToRun','applicationStatus','attendance','attendanceBulk','closeAttendanceSession','reopenAttendanceSession',
  'mergeParticipants','createUser','updateUser','changeMyPin','recordAccess','addAssessmentType','setAssessmentActive',
  'setProgramAssessments','saveAssessmentScore','saveSatisfaction','settings','backup','checkBackup','restoreBackup','certificate','import','logout',
] as const;

const GENERAL_ACTIONS=[
  'createParticipant','updateParticipant','createProgram','createRun','updateProgram','updateRunStatus','updateSession','createScheduleEvent',
  'apply','assignRun','applyToRun','applicationStatus','attendance','attendanceBulk','closeAttendanceSession','changeMyPin','recordAccess',
  'addAssessmentType','setAssessmentActive','setProgramAssessments','saveAssessmentScore','saveSatisfaction','certificate','import','logout',
] as const;

const ATTENDANCE_ACTIONS=['attendance','attendanceBulk','closeAttendanceSession','changeMyPin','recordAccess','logout'] as const;

const ALLOWED_ACTIONS:Record<StaffRole,ReadonlySet<string>>={
  '관리자':new Set(ADMIN_ACTIONS),
  '일반 담당자':new Set(GENERAL_ACTIONS),
  '출석 입력 전용':new Set(ATTENDANCE_ACTIONS),
};

export function canPerformAction(user:Pick<SafeUser,'role'>,action:string) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_ACTIONS,user.role)
    && ALLOWED_ACTIONS[user.role as StaffRole].has(action);
}

export function bearerToken(request:Request) {
  return request.headers.get('authorization')?.replace(/^Bearer\s+/i,'').trim()||'';
}

export function getAuthenticatedUser(request:Request,db:DatabaseSync) {
  const token=bearerToken(request);
  if(!token)return undefined;
  const now=new Date().toISOString();
  const user=db.prepare(`SELECT u.id,u.username,u.display_name,u.role,u.active,u.must_change_pin,u.last_login_at FROM auth_sessions s JOIN staff_users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1`).get(token,now) as SafeUser|undefined;
  if(user)db.prepare('UPDATE auth_sessions SET last_seen_at=? WHERE token=?').run(now,token);
  return user;
}

export function createAuthSession(db:DatabaseSync,userId:string,ipAddress:string) {
  const token=randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+8*60*60*1000).toISOString();
  db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(createdAt);
  db.prepare('INSERT INTO auth_sessions (token,user_id,expires_at,created_at,last_seen_at,ip_address) VALUES (?,?,?,?,?,?)').run(token,userId,expiresAt,createdAt,createdAt,ipAddress);
  return {token,createdAt,expiresAt};
}

export function invalidateAuthSession(request:Request,db:DatabaseSync) {
  const token=bearerToken(request);
  if(!token)return false;
  return db.prepare('DELETE FROM auth_sessions WHERE token=?').run(token).changes>0;
}

export function attendanceOnlySnapshot(db:DatabaseSync,currentUser:SafeUser) {
  const settings=Object.fromEntries((db.prepare(`SELECT key,value FROM settings WHERE key IN ('center_name','manager_name')`).all() as {key:string;value:string}[]).map(item=>[item.key,item.value]));
  return {
    settings,
    databasePath:'로컬 데이터베이스',
    storageInfo:{architecture:'단일 서버 프로세스',journalMode:'DELETE'},
    participants:[],
    duplicateGroups:[],
    programs:db.prepare(`SELECT id,name,delivery_type,session_count,capacity,status FROM programs WHERE status!='운영 종료' ORDER BY name`).all(),
    runs:db.prepare(`SELECT r.id,r.program_id,r.round_number,r.label,r.start_date,r.status,r.closed_at,r.closed_by,p.name AS program_name,p.delivery_type,p.session_count,p.capacity,COUNT(DISTINCT a.id) AS applicant_count FROM program_runs r JOIN programs p ON p.id=r.program_id LEFT JOIN applications a ON a.run_id=r.id GROUP BY r.id ORDER BY r.start_date DESC,r.round_number DESC`).all(),
    sessions:db.prepare(`SELECT s.id,s.run_id,s.session_number,s.session_date,s.session_time,s.location,s.attendance_status,s.attendance_closed_at,s.attendance_closed_by,s.reopen_reason,r.program_id,r.label AS run_label,p.name AS program_name FROM sessions s JOIN program_runs r ON r.id=s.run_id JOIN programs p ON p.id=r.program_id ORDER BY s.session_date DESC,s.session_time`).all(),
    applications:db.prepare(`SELECT a.id,a.participant_id,a.program_id,a.run_id,a.status,p.name AS participant_name,p.member_status,COALESCE(r.label,'차수 미배정') AS run_label,r.round_number,pr.name AS program_name,pr.delivery_type,pr.session_count,r.start_date FROM applications a JOIN participants p ON p.id=a.participant_id JOIN programs pr ON pr.id=a.program_id LEFT JOIN program_runs r ON r.id=a.run_id WHERE a.run_id IS NOT NULL ORDER BY a.id`).all(),
    attendance:db.prepare(`SELECT at.id,at.application_id,at.session_id,at.status,at.note,at.contacted_at,at.makeup_for_session_id,a.participant_id,a.run_id,p.name AS participant_name,s.session_number,s.session_date,s.session_time,pr.name AS program_name,r.label AS run_label FROM attendance at JOIN applications a ON a.id=at.application_id JOIN participants p ON p.id=a.participant_id JOIN sessions s ON s.id=at.session_id JOIN program_runs r ON r.id=a.run_id JOIN programs pr ON pr.id=a.program_id ORDER BY s.session_date DESC`).all(),
    certificates:[],auditLogs:[],backupFiles:[],users:[],currentUser,
    assessmentCatalog:[],programAssessments:[],assessmentScores:[],satisfactionSurveys:[],scheduleEvents:[],
  };
}
