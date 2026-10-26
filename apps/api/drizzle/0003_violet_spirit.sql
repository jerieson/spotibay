ALTER TABLE "chat_messages" ADD COLUMN "reply_to_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "media" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_id_chat_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;