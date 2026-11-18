import Database from "better-sqlite3";
import { asc, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { LoggedEvent, StoredEvent } from "@foundry/protocol";

/** One table: the append-only event log. Everything else is projected from it. */
export const events = sqliteTable("events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  kind: text("kind").notNull(),
  body: text("body", { mode: "json" }).notNull().$type<StoredEvent>(),
});

export class EventLog {
  private db;
  constructor(path: string) {
    const sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL
    )`);
    this.db = drizzle(sqlite);
  }
  append(ev: StoredEvent): LoggedEvent {
    const row = this.db.insert(events).values({ ts: ev.ts, kind: ev.kind, body: ev }).returning({ seq: events.seq }).get();
    return { ...ev, seq: row.seq } as LoggedEvent;
  }
  since(seq = 0): LoggedEvent[] {
    return this.db.select().from(events).where(gt(events.seq, seq)).orderBy(asc(events.seq)).all()
      .map((r) => ({ ...(r.body as StoredEvent), seq: r.seq }) as LoggedEvent);
  }
}
