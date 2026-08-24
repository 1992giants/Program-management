CREATE TABLE `certificates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`participant_id` text NOT NULL,
	`issued_at` text NOT NULL,
	`program_count` integer NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`birth_date` text NOT NULL,
	`phone` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `programs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`date` text NOT NULL,
	`time` text NOT NULL,
	`location` text NOT NULL,
	`manager` text NOT NULL,
	`capacity` integer NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`participant_id` text NOT NULL,
	`program_id` text NOT NULL,
	`applied_at` text NOT NULL,
	`attendance` text DEFAULT '신청' NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action
);
