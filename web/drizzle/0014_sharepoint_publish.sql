ALTER TABLE "documents" ADD COLUMN "sharepoint_folder_path" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sharepoint_pdf_path" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sharepoint_docx_path" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sharepoint_web_url" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sharepoint_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sharepoint_publishing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sharepoint_error" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "sharepoint_folder_path" text;