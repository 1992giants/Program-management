import { env } from 'cloudflare:workers';

export function getDatabase(): D1Database {
  if (!env.DB) throw new Error('데이터베이스 연결을 확인할 수 없습니다.');
  return env.DB;
}

export async function ensureDatabase() {
  const db = getDatabase();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, name TEXT NOT NULL, birth_date TEXT NOT NULL, phone TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS programs (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, location TEXT NOT NULL, manager TEXT NOT NULL, capacity INTEGER NOT NULL, status TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS registrations (id INTEGER PRIMARY KEY AUTOINCREMENT, participant_id TEXT NOT NULL REFERENCES participants(id), program_id TEXT NOT NULL REFERENCES programs(id), applied_at TEXT NOT NULL, attendance TEXT NOT NULL DEFAULT '신청')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS certificates (id INTEGER PRIMARY KEY AUTOINCREMENT, participant_id TEXT NOT NULL REFERENCES participants(id), issued_at TEXT NOT NULL, program_count INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_participants_name_birth ON participants(name, birth_date)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_registrations_participant ON registrations(participant_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_registrations_program ON registrations(program_id)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_participant_program ON registrations(participant_id, program_id)`),
  ]);
  const count = await db.prepare('SELECT COUNT(*) AS count FROM participants').first<{ count: number }>();
  if (!count?.count) await seedDatabase(db);
  return db;
}

async function seedDatabase(db: D1Database) {
  await db.batch([
    db.prepare('INSERT INTO participants (id,name,birth_date,phone,note,created_at) VALUES (?,?,?,?,?,?)').bind('P-2025-0142','김민준','1991-04-18','010-2415-9181','','2025-08-21'),
    db.prepare('INSERT INTO participants (id,name,birth_date,phone,note,created_at) VALUES (?,?,?,?,?,?)').bind('P-2025-0108','이서연','1987-11-03','010-5822-3120','','2025-08-19'),
    db.prepare('INSERT INTO participants (id,name,birth_date,phone,note,created_at) VALUES (?,?,?,?,?,?)').bind('P-2025-0086','박지훈','1996-02-27','010-9164-5544','','2025-08-14'),
    db.prepare('INSERT INTO participants (id,name,birth_date,phone,note,created_at) VALUES (?,?,?,?,?,?)').bind('P-2025-0061','최은영','1979-09-12','010-3721-9906','','2025-08-07'),
    db.prepare('INSERT INTO programs (id,name,category,date,time,location,manager,capacity,status) VALUES (?,?,?,?,?,?,?,?,?)').bind('PRG-001','마음챙김 명상교실','정서회복','2025-08-25','10:00','프로그램실 A','이지은',10,'진행 중'),
    db.prepare('INSERT INTO programs (id,name,category,date,time,location,manager,capacity,status) VALUES (?,?,?,?,?,?,?,?,?)').bind('PRG-002','함께 걷는 회복 산책','신체활동','2025-08-25','14:00','센터 앞 공원','박서준',15,'예정'),
    db.prepare('INSERT INTO programs (id,name,category,date,time,location,manager,capacity,status) VALUES (?,?,?,?,?,?,?,?,?)').bind('PRG-003','미술로 만나는 나','예술치유','2025-08-25','16:30','프로그램실 B','김하늘',8,'예정'),
    db.prepare('INSERT INTO programs (id,name,category,date,time,location,manager,capacity,status) VALUES (?,?,?,?,?,?,?,?,?)').bind('PRG-004','마음건강 글쓰기','정서회복','2025-08-14','15:00','프로그램실 A','이지은',12,'완료'),
  ]);
  await db.batch([
    db.prepare('INSERT INTO registrations (participant_id,program_id,applied_at,attendance) VALUES (?,?,?,?)').bind('P-2025-0142','PRG-001','2025-08-12','참석'),
    db.prepare('INSERT INTO registrations (participant_id,program_id,applied_at,attendance) VALUES (?,?,?,?)').bind('P-2025-0108','PRG-001','2025-08-11','참석'),
    db.prepare('INSERT INTO registrations (participant_id,program_id,applied_at,attendance) VALUES (?,?,?,?)').bind('P-2025-0086','PRG-002','2025-08-13','신청'),
    db.prepare('INSERT INTO registrations (participant_id,program_id,applied_at,attendance) VALUES (?,?,?,?)').bind('P-2025-0061','PRG-003','2025-08-16','신청'),
    db.prepare('INSERT INTO registrations (participant_id,program_id,applied_at,attendance) VALUES (?,?,?,?)').bind('P-2025-0142','PRG-004','2025-08-02','참석'),
    db.prepare('PRAGMA optimize'),
  ]);
}
