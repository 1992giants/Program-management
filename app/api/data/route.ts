import { ensureDatabase } from '@/db';

export const runtime = 'edge';

async function snapshot() {
  const db = await ensureDatabase();
  const [participants, programs, registrations, certificates] = await Promise.all([
    db.prepare(`SELECT p.*, COUNT(r.id) AS program_count, MAX(pr.date) AS last_visit FROM participants p LEFT JOIN registrations r ON r.participant_id=p.id LEFT JOIN programs pr ON pr.id=r.program_id GROUP BY p.id ORDER BY p.created_at DESC`).all(),
    db.prepare(`SELECT pr.*, COUNT(r.id) AS registered_count FROM programs pr LEFT JOIN registrations r ON r.program_id=pr.id GROUP BY pr.id ORDER BY pr.date DESC, pr.time`).all(),
    db.prepare(`SELECT r.id, r.participant_id, r.program_id, r.applied_at, r.attendance, p.name AS participant_name, p.birth_date, pr.name AS program_name, pr.date, pr.time, pr.location FROM registrations r JOIN participants p ON p.id=r.participant_id JOIN programs pr ON pr.id=r.program_id ORDER BY pr.date DESC, pr.time DESC`).all(),
    db.prepare(`SELECT c.*, p.name AS participant_name FROM certificates c JOIN participants p ON p.id=c.participant_id ORDER BY c.issued_at DESC`).all(),
  ]);
  return { participants: participants.results, programs: programs.results, registrations: registrations.results, certificates: certificates.results };
}

export async function GET() {
  try { return Response.json(await snapshot()); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : '데이터를 불러오지 못했습니다.' }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const db = await ensureDatabase();
    const today = new Date().toISOString().slice(0, 10);
    if (body.action === 'createParticipant') {
      const id = `P-${today.slice(0,4)}-${String(Date.now()).slice(-4)}`;
      await db.prepare('INSERT INTO participants (id,name,birth_date,phone,note,created_at) VALUES (?,?,?,?,?,?)').bind(id, body.name, body.birthDate, body.phone, body.note ?? '', today).run();
    } else if (body.action === 'createProgram') {
      const id = `PRG-${String(Date.now()).slice(-6)}`;
      await db.prepare('INSERT INTO programs (id,name,category,date,time,location,manager,capacity,status) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, body.name, body.category, body.date, body.time, body.location, body.manager, Number(body.capacity), '예정').run();
    } else if (body.action === 'register') {
      await db.prepare(`INSERT INTO registrations (participant_id,program_id,applied_at,attendance) VALUES (?,?,?,'신청') ON CONFLICT(participant_id,program_id) DO NOTHING`).bind(body.participantId, body.programId, today).run();
    } else if (body.action === 'attendance') {
      await db.prepare('UPDATE registrations SET attendance=? WHERE id=?').bind(body.attendance, body.id).run();
    } else if (body.action === 'certificate') {
      await db.prepare('INSERT INTO certificates (participant_id,issued_at,program_count) VALUES (?,?,?)').bind(body.participantId, today, Number(body.programCount)).run();
    } else if (body.action === 'import') {
      const rows = Array.isArray(body.rows) ? body.rows as Record<string, unknown>[] : [];
      for (const row of rows.slice(0, 500)) {
        const name = String(row.name ?? '').trim();
        if (!name) continue;
        let participant = await db.prepare('SELECT id FROM participants WHERE name=? AND birth_date=?').bind(name, row.birthDate ?? '').first<{id:string}>();
        if (!participant) {
          const id = `P-${today.slice(0,4)}-${String(Date.now() + Math.random()).replace(/\D/g,'').slice(-6)}`;
          await db.prepare('INSERT INTO participants (id,name,birth_date,phone,note,created_at) VALUES (?,?,?,?,?,?)').bind(id, name, row.birthDate ?? '', row.phone ?? '', 'Excel 가져오기', today).run();
          participant = { id };
        }
        const programName = String(row.programName ?? '').trim();
        if (programName) {
          const program = await db.prepare('SELECT id FROM programs WHERE name=?').bind(programName).first<{id:string}>();
          if (program) await db.prepare(`INSERT INTO registrations (participant_id,program_id,applied_at,attendance) VALUES (?,?,?,?) ON CONFLICT(participant_id,program_id) DO UPDATE SET attendance=excluded.attendance`).bind(participant.id, program.id, row.appliedAt ?? today, row.attendance ?? '신청').run();
        }
      }
    } else return Response.json({ error: '지원하지 않는 작업입니다.' }, { status: 400 });
    return Response.json(await snapshot());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '저장하지 못했습니다.' }, { status: 500 });
  }
}
