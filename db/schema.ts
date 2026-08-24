import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const participants = sqliteTable('participants', {
  id: text('id').primaryKey(), name: text('name').notNull(), birthDate: text('birth_date').notNull(), phone: text('phone').notNull(), note: text('note').notNull().default(''), createdAt: text('created_at').notNull(),
}, (table) => [index('idx_participants_name_birth').on(table.name, table.birthDate)]);
export const programs = sqliteTable('programs', {
  id: text('id').primaryKey(), name: text('name').notNull(), category: text('category').notNull(), date: text('date').notNull(), time: text('time').notNull(), location: text('location').notNull(), manager: text('manager').notNull(), capacity: integer('capacity').notNull(), status: text('status').notNull(),
});
export const registrations = sqliteTable('registrations', {
  id: integer('id').primaryKey({ autoIncrement: true }), participantId: text('participant_id').notNull().references(() => participants.id), programId: text('program_id').notNull().references(() => programs.id), appliedAt: text('applied_at').notNull(), attendance: text('attendance').notNull().default('신청'),
}, (table) => [
  uniqueIndex('idx_registrations_participant_program').on(table.participantId, table.programId),
  index('idx_registrations_participant').on(table.participantId),
  index('idx_registrations_program').on(table.programId),
]);
export const certificates = sqliteTable('certificates', {
  id: integer('id').primaryKey({ autoIncrement: true }), participantId: text('participant_id').notNull().references(() => participants.id), issuedAt: text('issued_at').notNull(), programCount: integer('program_count').notNull(),
});
