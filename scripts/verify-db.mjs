import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.env.ONMAEUM_DB_PATH || path.join(process.cwd(),'data','onmaeum.sqlite'));
mkdirSync(path.dirname(file),{recursive:true});
const db = new DatabaseSync(file);
const indexes = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all();
const plans = {
  participantSearch: db.prepare('EXPLAIN QUERY PLAN SELECT * FROM participants WHERE name=?').all('김민준'),
  programApplications: db.prepare('EXPLAIN QUERY PLAN SELECT * FROM applications WHERE program_id=?').all('PRG-001'),
  runApplications: db.prepare('EXPLAIN QUERY PLAN SELECT * FROM applications WHERE run_id=?').all('RUN-PRG-001-1'),
  sessionAttendance: db.prepare('EXPLAIN QUERY PLAN SELECT * FROM attendance WHERE session_id=?').all('RUN-PRG-001-1-S1'),
};
console.log(JSON.stringify({file,indexes,plans},null,2));
