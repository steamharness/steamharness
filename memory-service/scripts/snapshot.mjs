// SQLite online snapshots include WAL contents. PostgreSQL metadata must be backed up with this volume.
import { DatabaseSync } from 'node:sqlite';
import { readdir,mkdir } from 'node:fs/promises';
import path from 'node:path';
const [source,destination]=process.argv.slice(2);
if(!source||!destination)throw new Error('Usage: node scripts/snapshot.mjs <memory-data-directory> <new-backup-directory>');
await mkdir(destination,{recursive:false,mode:0o700});
for(const account of await readdir(source,{withFileTypes:true})){
 if(!account.isDirectory()||!/^[a-f0-9]{64}$/.test(account.name))continue;
 const target=path.join(destination,account.name);await mkdir(target,{mode:0o700});
 const db=new DatabaseSync(path.join(source,account.name,'memory.sqlite'));
 try{const output=path.join(target,'memory.sqlite');db.exec(`VACUUM INTO '${output.replaceAll("'","''")}'`);if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Source database integrity check failed.');}finally{db.close();}
}
