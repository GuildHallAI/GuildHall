import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
 userId: text("user_id").primaryKey(), balance: integer("balance").notNull().default(250000),
 perAction: integer("per_action").notNull().default(100000), dailyLimit: integer("daily_limit").notNull().default(500000),
 paused: integer("paused").notNull().default(0), createdAt: text("created_at").notNull(),
});
export const commissions = sqliteTable("commissions", {
 id:text("id").primaryKey(), userId:text("user_id").notNull(), reference:text("reference").notNull(),
 title:text("title").notNull(), brief:text("brief").notNull(), category:text("category").notNull(),
 agent:text("agent").notNull(), budget:integer("budget").notNull(), asset:text("asset").notNull().default("USDC"),
 state:text("state").notNull().default("Open"), deadline:text("deadline").notNull(),
 deliverable:text("deliverable"), deliverableHash:text("deliverable_hash"), ruling:text("ruling"),
 nonce:text("nonce"), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
},t=>[index("idx_commissions_user_state").on(t.userId,t.state)]);
export const events = sqliteTable("events", {
 id:text("id").primaryKey(),userId:text("user_id").notNull(),commissionId:text("commission_id"),
 title:text("title").notNull(),detail:text("detail").notNull(),amount:integer("amount").notNull().default(0),
 createdAt:text("created_at").notNull(),
},t=>[index("idx_events_user_created").on(t.userId,t.createdAt)]);
export const charters = sqliteTable("charters", {
 id:text("id").primaryKey(), userId:text("user_id").notNull(), agent:text("agent").notNull(),
 symbol:text("symbol").notNull(), createdAt:text("created_at").notNull(),
},t=>[index("idx_charters_user").on(t.userId)]);
