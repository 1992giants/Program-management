CREATE INDEX `idx_participants_name_birth` ON `participants` (`name`,`birth_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_registrations_participant_program` ON `registrations` (`participant_id`,`program_id`);--> statement-breakpoint
CREATE INDEX `idx_registrations_participant` ON `registrations` (`participant_id`);--> statement-breakpoint
CREATE INDEX `idx_registrations_program` ON `registrations` (`program_id`);