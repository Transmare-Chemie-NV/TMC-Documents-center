CREATE TYPE "public"."remark_category" AS ENUM('missing_rows', 'wrong_field', 'supplier_leak', 'layout', 'good_example', 'other');--> statement-breakpoint
CREATE TABLE "document_remarks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"remark" text NOT NULL,
	"training_flag" boolean DEFAULT false NOT NULL,
	"category" "remark_category" DEFAULT 'other' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_remarks_length" CHECK (char_length(trim("remark")) BETWEEN 3 AND 1000)
);--> statement-breakpoint
ALTER TABLE "document_remarks" ADD CONSTRAINT "document_remarks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_remarks_doc_created" ON "document_remarks" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "document_remarks_training_created" ON "document_remarks" USING btree ("training_flag","created_at");--> statement-breakpoint
CREATE INDEX "document_remarks_actor_created" ON "document_remarks" USING btree ("actor","created_at");
