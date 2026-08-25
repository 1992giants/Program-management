import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

let database: DatabaseSync | null = null;

export function getDatabasePath() {
  const configuredPath = process.env.ONMAEUM_DB_PATH;
  return configuredPath
    ? path.resolve(/* turbopackIgnore: true */ configuredPath)
    : path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'onmaeum.sqlite');
}

export function getBackupDirectory() {
  const configuredPath = process.env.ONMAEUM_BACKUP_DIR;
  return configuredPath
    ? path.resolve(/* turbopackIgnore: true */ configuredPath)
    : path.join(/* turbopackIgnore: true */ path.dirname(getDatabasePath()), 'backups');
}

export function getStorageInfo() {
  const databasePath=getDatabasePath(),backupDirectory=getBackupDirectory();
  const networkPath=/^(\\\\|\/\/)/.test(databasePath);
  return {databasePath,backupDirectory,networkPath,journalMode:'DELETE',architecture:'단일 서버 프로세스'};
}

export function getDatabase() {
  if (database) return database;
  const filePath = getDatabasePath();
  if (/^(\\\\|\/\/)/.test(filePath) && process.env.ONMAEUM_ALLOW_NETWORK_DB !== '1') {
    throw new Error('실시간 SQLite 파일은 네트워크 공유 경로에 둘 수 없습니다. 서버 PC의 로컬 경로를 사용하고 외장·네트워크 드라이브는 백업 경로로 지정하세요.');
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  mkdirSync(getBackupDirectory(), { recursive: true });
  database = new DatabaseSync(filePath);
  database.exec('PRAGMA foreign_keys = ON');
  // DELETE journal mode is slower than WAL but works more reliably on removable
  // drives and SMB-style internal shares when one server process owns the file.
  database.exec('PRAGMA journal_mode = DELETE');
  database.exec('PRAGMA synchronous = FULL');
  database.exec('PRAGMA busy_timeout = 5000');
  ensureDatabase(database);
  return database;
}

function ensureDatabase(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      gender TEXT NOT NULL DEFAULT '미입력',
      age INTEGER NOT NULL DEFAULT 0,
      phone TEXT NOT NULL DEFAULT '',
      member_status TEXT NOT NULL DEFAULT '비회원',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS programs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      delivery_type TEXT NOT NULL DEFAULT '집단',
      session_count INTEGER NOT NULL DEFAULT 1,
      recurrence TEXT NOT NULL DEFAULT '매주',
      location TEXT NOT NULL DEFAULT '',
      manager TEXT NOT NULL DEFAULT '',
      capacity INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT '운영 중',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS program_runs (
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '모집 중',
      UNIQUE(program_id, round_number)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES program_runs(id) ON DELETE CASCADE,
      session_number INTEGER NOT NULL,
      session_date TEXT NOT NULL,
      session_time TEXT NOT NULL,
      location TEXT NOT NULL,
      UNIQUE(run_id, session_number)
    );
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES program_runs(id) ON DELETE SET NULL,
      applied_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '신청',
      UNIQUE(participant_id, program_id)
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT '미입력',
      note TEXT NOT NULL DEFAULT '',
      UNIQUE(application_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id TEXT NOT NULL REFERENCES participants(id),
      issued_at TEXT NOT NULL,
      session_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT NOT NULL DEFAULT '',
      after_json TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS staff_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '일반 담당자',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      min_score INTEGER NOT NULL DEFAULT 0,
      max_score INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS program_assessments (
      program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      assessment_id TEXT NOT NULL REFERENCES assessment_catalog(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(program_id, assessment_id)
    );
    CREATE TABLE IF NOT EXISTS assessment_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      assessment_id TEXT NOT NULL REFERENCES assessment_catalog(id) ON DELETE CASCADE,
      pre_score REAL,
      post_score REAL,
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE(application_id, assessment_id)
    );
    CREATE TABLE IF NOT EXISTS satisfaction_surveys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
      score INTEGER,
      comment TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedule_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL DEFAULT '상담',
      color TEXT NOT NULL DEFAULT 'green',
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      event_date TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      start_time TEXT NOT NULL DEFAULT '',
      end_time TEXT NOT NULL DEFAULT '',
      recurrence TEXT NOT NULL DEFAULT '1회',
      delivery_mode TEXT NOT NULL DEFAULT '대면',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_participants_name ON participants(name);
    CREATE INDEX IF NOT EXISTS idx_runs_program ON program_runs(program_id, round_number);
    CREATE INDEX IF NOT EXISTS idx_sessions_run_date ON sessions(run_id, session_date);
    CREATE INDEX IF NOT EXISTS idx_applications_participant ON applications(participant_id);
    CREATE INDEX IF NOT EXISTS idx_applications_run ON applications(run_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_application ON attendance(application_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(session_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_auth_user ON auth_sessions(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_scores_application ON assessment_scores(application_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_events_date ON schedule_events(event_date, start_time);
    CREATE INDEX IF NOT EXISTS idx_schedule_events_participant ON schedule_events(participant_id);
  `);
  migrateApplications(db);
  migrateOperations(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_applications_program ON applications(program_id)');
  const center = db.prepare('SELECT value FROM settings WHERE key = ?').get('center_name');
  if (!center) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('center_name', '마음봄 정신건강복지센터');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('manager_name', '프로그램 담당자');
  }
  const seedDate=new Date().toISOString().slice(0,10);
  const userCount=db.prepare('SELECT COUNT(*) AS count FROM staff_users').get() as {count:number};
  if(!userCount.count) db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at) VALUES (?,?,?,?,?,?,?)').run('USR-ADMIN','admin','센터 관리자',hashPin('admin','1234'),'관리자',1,seedDate);
  const insertAssessment=db.prepare('INSERT OR IGNORE INTO assessment_catalog (id,name,min_score,max_score,active,created_at) VALUES (?,?,?,?,1,?)');
  insertAssessment.run('ASM-PHQ9','PHQ-9',0,27,seedDate);
  insertAssessment.run('ASM-GAD7','GAD-7',0,21,seedDate);
  insertAssessment.run('ASM-PSS10','PSS-10',0,40,seedDate);
  const count = db.prepare('SELECT COUNT(*) AS count FROM participants').get() as { count:number };
  if (!count.count) seedDatabase(db);
  db.exec('PRAGMA optimize');
}

function ensureColumn(db:DatabaseSync,table:string,column:string,definition:string) {
  const columns=db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[];
  if(!columns.some(item=>item.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateOperations(db:DatabaseSync) {
  ensureColumn(db,'program_runs','closed_at','TEXT');
  ensureColumn(db,'program_runs','closed_by','TEXT');
  ensureColumn(db,'sessions','attendance_status',"TEXT NOT NULL DEFAULT '작성 중'");
  ensureColumn(db,'sessions','attendance_closed_at','TEXT');
  ensureColumn(db,'sessions','attendance_closed_by','TEXT');
  ensureColumn(db,'sessions','reopen_reason',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'applications','queue_number','INTEGER');
  ensureColumn(db,'applications','status_reason',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'applications','status_updated_at',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'applications','assigned_at','TEXT');
  ensureColumn(db,'attendance','contacted_at','TEXT');
  ensureColumn(db,'attendance','makeup_for_session_id','TEXT');
  ensureColumn(db,'assessment_catalog','version',"TEXT NOT NULL DEFAULT '1.0'");
  ensureColumn(db,'assessment_catalog','description',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'assessment_scores','pre_date','TEXT');
  ensureColumn(db,'assessment_scores','post_date','TEXT');
  ensureColumn(db,'assessment_scores','not_completed_reason',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'assessment_scores','assessor',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'satisfaction_surveys','survey_version',"TEXT NOT NULL DEFAULT '1.0'");
  ensureColumn(db,'satisfaction_surveys','anonymous','INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db,'staff_users','failed_attempts','INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db,'staff_users','locked_until','TEXT');
  ensureColumn(db,'staff_users','last_login_at','TEXT');
  ensureColumn(db,'staff_users','pin_changed_at','TEXT');
  ensureColumn(db,'staff_users','must_change_pin','INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db,'auth_sessions','last_seen_at','TEXT');
  ensureColumn(db,'auth_sessions','ip_address',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'audit_logs','ip_address',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'audit_logs','reason',"TEXT NOT NULL DEFAULT ''");
  const applications=db.prepare(`SELECT id,program_id,applied_at FROM applications WHERE queue_number IS NULL ORDER BY program_id,applied_at,id`).all() as {id:number;program_id:string}[];
  const counters=new Map<string,number>();
  for(const row of db.prepare(`SELECT program_id,COALESCE(MAX(queue_number),0) AS max_queue FROM applications WHERE queue_number IS NOT NULL GROUP BY program_id`).all() as {program_id:string;max_queue:number}[])counters.set(row.program_id,row.max_queue);
  const update=db.prepare('UPDATE applications SET queue_number=?,status_updated_at=CASE WHEN status_updated_at=\'\' THEN applied_at ELSE status_updated_at END WHERE id=?');
  for(const application of applications){const next=(counters.get(application.program_id)||0)+1;counters.set(application.program_id,next);update.run(next,application.id)}
  db.exec('CREATE INDEX IF NOT EXISTS idx_applications_workflow ON applications(status,run_id,applied_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_attendance_status ON sessions(attendance_status,session_date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_locked ON staff_users(active,locked_until)');
}

function seedDatabase(db: DatabaseSync) {
  const today = '2026-08-24';
  const participantRows = [
    ['P-2026-0001','김민준','남성',35,'010-2415-9181','회원','불안 완화 프로그램에 관심',today],
    ['P-2026-0002','이서연','여성',39,'010-5822-3120','회원','오후 시간 선호',today],
    ['P-2026-0003','박지훈','남성',30,'010-9164-5544','비회원','첫 이용',today],
    ['P-2026-0004','최은영','여성',46,'010-3721-9906','회원','보호자 동행 가능',today],
  ];
  const insertParticipant = db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)');
  for (const row of participantRows) insertParticipant.run(...row);
  const programRows = [
    ['PRG-001','마음챙김 명상교실','정서회복','집단',3,'매월','프로그램실 A','이지은',10,'운영 중',today],
    ['PRG-002','개별 회복 코칭','개별상담','1:1',4,'매주','상담실 2','박서준',1,'운영 중',today],
    ['PRG-003','함께 걷는 회복 산책','신체활동','집단',2,'매월','센터 앞 공원','김하늘',15,'운영 중',today],
  ];
  const insertProgram = db.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const row of programRows) insertProgram.run(...row);
  createRun(db,'PRG-001',1,'2026년 8월 1차','2026-08-05','10:00');
  createRun(db,'PRG-001',2,'2026년 9월 2차','2026-09-02','10:00');
  createRun(db,'PRG-002',1,'김민준 1차','2026-08-07','14:00');
  createRun(db,'PRG-003',1,'2026년 8월 1차','2026-08-12','15:00');
  const insertApplication = db.prepare('INSERT INTO applications (participant_id,program_id,run_id,applied_at,status) VALUES (?,?,?,?,?)');
  insertApplication.run('P-2026-0001','PRG-001','RUN-PRG-001-1','2026-07-25','참가중');
  insertApplication.run('P-2026-0002','PRG-001','RUN-PRG-001-1','2026-07-26','참가중');
  insertApplication.run('P-2026-0003','PRG-001',null,'2026-08-20','신청');
  insertApplication.run('P-2026-0001','PRG-002','RUN-PRG-002-1','2026-08-01','참가중');
  insertApplication.run('P-2026-0004','PRG-003','RUN-PRG-003-1','2026-08-03','참가대기');
}

function migrateApplications(db:DatabaseSync) {
  const columns = db.prepare('PRAGMA table_info(applications)').all() as {name:string}[];
  if (!columns.some(column=>column.name==='program_id')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE applications_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES program_runs(id) ON DELETE SET NULL,
        applied_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '신청',
        UNIQUE(participant_id, program_id)
      )`);
      db.exec(`INSERT INTO applications_new (id,participant_id,program_id,run_id,applied_at,status)
        SELECT a.id,a.participant_id,r.program_id,a.run_id,a.applied_at,
          CASE WHEN a.status IN ('승인','대기') THEN '참가대기' ELSE a.status END
        FROM applications a JOIN program_runs r ON r.id=a.run_id`);
      db.exec('DROP TABLE applications');
      db.exec('ALTER TABLE applications_new RENAME TO applications');
      db.exec('CREATE INDEX idx_applications_participant ON applications(participant_id)');
      db.exec('CREATE INDEX idx_applications_program ON applications(program_id)');
      db.exec('CREATE INDEX idx_applications_run ON applications(run_id)');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  db.exec(`UPDATE applications SET status='참가대기' WHERE status IN ('승인','대기')`);
}

export function createRun(db: DatabaseSync, programId:string, roundNumber:number, label:string, startDate:string, time:string) {
  const program = db.prepare('SELECT session_count, recurrence, location FROM programs WHERE id=?').get(programId) as {session_count:number;recurrence:string;location:string};
  const runId = `RUN-${programId}-${roundNumber}`;
  db.prepare('INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,?)').run(runId,programId,roundNumber,label,startDate,'모집 중');
  const insert = db.prepare('INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES (?,?,?,?,?,?)');
  for (let i=1;i<=program.session_count;i++) {
    const date = addInterval(startDate, i-1, program.recurrence);
    insert.run(`${runId}-S${i}`,runId,i,date,time,program.location);
  }
  return runId;
}

function addInterval(startDate:string, offset:number, recurrence:string) {
  const date = new Date(`${startDate}T00:00:00`);
  if (recurrence === '매일') date.setDate(date.getDate()+offset);
  else if (recurrence === '매월') date.setMonth(date.getMonth()+offset);
  else date.setDate(date.getDate()+offset*7);
  return date.toISOString().slice(0,10);
}

export function databaseExists() { return existsSync(getDatabasePath()); }
function legacyPinHash(username:string,pin:string) { return createHash('sha256').update(`onmaeum-local|${username.trim().toLowerCase()}|${pin}`).digest('hex'); }
export function hashPin(username:string,pin:string) { const salt=randomBytes(16).toString('hex');return `scrypt$${salt}$${scryptSync(pin,`onmaeum-local|${username.trim().toLowerCase()}|${salt}`,32).toString('hex')}`; }
export function verifyPin(username:string,pin:string,stored:string) {
  if(!stored.startsWith('scrypt$'))return stored===legacyPinHash(username,pin);
  const parts=stored.split('$'),salt=parts.length===3?`onmaeum-local|${username.trim().toLowerCase()}|${parts[1]}`:`onmaeum-local|${username.trim().toLowerCase()}`,hash=parts.length===3?parts[2]:parts[1];
  const expected=Buffer.from(hash,'hex'),actual=scryptSync(pin,salt,32);
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
