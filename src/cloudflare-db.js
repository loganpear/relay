import {schema,migrations} from './cloudflare-schema.js';

// Implements the small synchronous SQLite interface TaskStore uses, backed by durable SQL.
export class CloudflareDatabase {
  constructor(storage) {
    this.storage=storage;
    if(!this.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()){
      storage.transactionSync(()=>{
        this.exec(schema);
        for(const name of migrations)this.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(name);
      });
    }
  }
  exec(sql) {
    // Cloudflare manages journaling and foreign-key enforcement; these Node pragmas do not apply.
    const query=sql.replace(/PRAGMA\s+(?:journal_mode|foreign_keys)\s*=\s*\w+\s*;?/gi,'').trim();
    if(query)this.storage.sql.exec(query);
  }
  prepare(sql) {
    return {
      all:(...args)=>this.storage.sql.exec(sql,...args).toArray(),
      get:(...args)=>this.storage.sql.exec(sql,...args).toArray()[0],
      run:(...args)=>{
        this.storage.sql.exec(sql,...args).toArray();
        return this.storage.sql.exec('SELECT changes() AS changes,last_insert_rowid() AS lastInsertRowid').toArray()[0];
      }
    };
  }
  transaction(fn){return this.storage.transactionSync(fn);}
  close(){}
}
