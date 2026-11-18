import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TaskStore as BaseTaskStore } from './task-store.js';
export * from './task-store.js';

// The Node entry point preserves local SQLite operation; Cloudflare injects durable storage instead.
export class TaskStore extends BaseTaskStore {
  constructor(path = ':memory:') {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    super(new DatabaseSync(path));
  }
}
