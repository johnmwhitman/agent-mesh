import Database from "better-sqlite3";

const [dbFile] = process.argv.slice(2);
if (!dbFile) throw new Error("usage: storage-v3-reader DB");

const db = new Database(dbFile, { readonly: true, fileMustExist: true });
try {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'storage_schema_version'").get();
  if (!row || !/^[1-9][0-9]*$/.test(row.value)) {
    process.stderr.write("v3 reader refused malformed or missing storage version\n");
    process.exitCode = 2;
  } else if (Number(row.value) > 3) {
    process.stderr.write("v3 reader refused newer physical storage version " + row.value + "\n");
    process.exitCode = 3;
  } else {
    process.stdout.write(JSON.stringify({ storageVersion: Number(row.value) }));
  }
} finally {
  db.close();
}
