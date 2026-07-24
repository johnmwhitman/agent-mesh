import Database from "better-sqlite3";
const { readLedger, closeDb, withLedger } = await import("../src/db.js");
readLedger();
closeDb();
const file = process.env.MESHFLEET_DB_FILE!;
function dump(label: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(r=>r.name);
  const occupied: Record<string, number> = {};
  for (const t of tables) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as {n:number}).n;
    if (n > 0) occupied[t] = n;
  }
  console.log(label, "tables=", tables.length, "OCCUPIED=", JSON.stringify(occupied));
  db.close();
}
dump("FRESH:");
withLedger((d) => { d.fleets["f1"] = { id: "f1", status: "running", created_at: 1 } as any; });
closeDb();
dump("AFTER-ONE-FLEET:");
