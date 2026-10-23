import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class TaskError extends Error {}
export const statuses = ['todo', 'done'];
export const labels = { todo: 'To do', done: 'Done' };

export function parseTask(text) {
  const match = text.trim().match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>\s+(.+)$/s);
  if (!match) throw new TaskError('Use /task @someone Task title --due YYYY-MM-DD. Select the person from Slack’s suggestions.');
  let title = match[2].trim();
  // Accept the former flag on old saved commands; completion is now always direct.
  title = title.replace(/(?:^|\s)--no-review(?=\s|$)/g, ' ').trim();
  let dueDate = null;
  const due = title.match(/(?:^|\s)--due\s+(\S+)/);
  if (due) {
    dueDate = due[1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate) {
      throw new TaskError('Use a real due date in YYYY-MM-DD format.');
    }
    title = title.replace(due[0], ' ').trim();
  }
  if (title.includes('--')) throw new TaskError('Supported option: --due YYYY-MM-DD.');
  if (!title || title.length > 240) throw new TaskError('Give the task a title between 1 and 240 characters.');
  return { assigneeId: match[1], title, dueDate };
}

export class TaskStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teamId TEXT NOT NULL, channelId TEXT NOT NULL,
        title TEXT NOT NULL, assigneeId TEXT NOT NULL, creatorId TEXT NOT NULL,
        dueDate TEXT, requiresReview INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo', version INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, messageTs TEXT,
        lastComment TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_team_channel ON tasks(teamId, channelId);
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY, taskId INTEGER REFERENCES tasks(id),
        actorId TEXT NOT NULL, action TEXT NOT NULL, comment TEXT, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, taskId INTEGER);
      CREATE TABLE IF NOT EXISTS outbox (
        taskId INTEGER PRIMARY KEY REFERENCES tasks(id), attempts INTEGER NOT NULL DEFAULT 0,
        nextAttempt INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE TABLE IF NOT EXISTS completion_notifications (
        taskId INTEGER PRIMARY KEY REFERENCES tasks(id),
        attempts INTEGER NOT NULL DEFAULT 0, nextAttempt INTEGER NOT NULL DEFAULT 0,
        error TEXT, sentTs TEXT
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY);
    `);
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('two-status-tasks')) return;
      // Preserve finished tasks, return all unfinished work to To do, and refresh old cards.
      const existing = this.db.prepare('SELECT id FROM tasks').all();
      this.db.exec("UPDATE tasks SET status=CASE WHEN status='done' THEN 'done' ELSE 'todo' END,requiresReview=0,lastComment=NULL,version=version+1");
      for (const task of existing) this.enqueue(task.id);
      this.db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('two-status-tasks');
    });
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id, teamId) { return this.db.prepare('SELECT * FROM tasks WHERE id=? AND teamId=?').get(id, teamId); }
  receipt(key) { return this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key); }
  enqueue(id) {
    this.db.prepare('INSERT INTO outbox(taskId) VALUES (?) ON CONFLICT(taskId) DO UPDATE SET attempts=0,nextAttempt=0,error=NULL').run(id);
  }
  create(input, receiptKey) {
    return this.transaction(() => {
      if (receiptKey && this.receipt(receiptKey)) return this.get(this.receipt(receiptKey).taskId, input.teamId);
      const now = new Date().toISOString();
      const result = this.db.prepare(`INSERT INTO tasks(teamId,channelId,title,assigneeId,creatorId,dueDate,requiresReview,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(input.teamId, input.channelId, input.title, input.assigneeId, input.creatorId, input.dueDate ?? null, 0, now, now);
      const id = Number(result.lastInsertRowid);
      this.db.prepare('INSERT INTO history(taskId,actorId,action,createdAt) VALUES (?,?,?,?)').run(id, input.creatorId, 'created', now);
      if (receiptKey) this.db.prepare('INSERT INTO receipts(key,taskId) VALUES (?,?)').run(receiptKey, id);
      this.enqueue(id);
      return this.get(id, input.teamId);
    });
  }
  transition({ id, teamId, channelId, actorId, action, version, receiptKey }) {
    return this.transaction(() => {
      const task = this.get(id, teamId);
      if (!task || task.channelId !== channelId) throw new TaskError('That task is not available in this channel.');
      if (receiptKey && this.receipt(receiptKey)) return task;
      if (version !== undefined && task.version !== version) throw new TaskError('This card has changed. Use its latest buttons, or run /tasks mine for the current status.');
      if (action !== 'complete' || task.status !== 'todo' || actorId !== task.assigneeId) throw new TaskError('This action is unavailable. Only the assignee can mark an unfinished task done.');
      const now = new Date().toISOString();
      this.db.prepare("UPDATE tasks SET status='done',version=version+1,updatedAt=? WHERE id=?").run(now, id);
      this.db.prepare('INSERT INTO history(taskId,actorId,action,createdAt) VALUES (?,?,?,?)').run(id, actorId, 'complete', now);
      this.db.prepare('INSERT INTO completion_notifications(taskId) VALUES (?)').run(id);
      if (receiptKey) this.db.prepare('INSERT INTO receipts(key,taskId) VALUES (?,?)').run(receiptKey, id);
      this.enqueue(id);
      return this.get(id, teamId);
    });
  }
  list({ teamId, channelId, userId, mode = 'team', includeDone = false }) {
    let sql = 'SELECT * FROM tasks WHERE teamId=? AND channelId=?';
    const args = [teamId, channelId];
    if (mode === 'mine') { sql += ' AND assigneeId=?'; args.push(userId); }
    if (mode === 'assigned') { sql += ' AND creatorId=?'; args.push(userId); }
    if (!includeDone) sql += " AND status!='done'";
    return this.db.prepare(sql + ' ORDER BY createdAt DESC,id DESC LIMIT 50').all(...args);
  }
  history(id) { return this.db.prepare('SELECT * FROM history WHERE taskId=? ORDER BY id').all(id); }
  pending() { return this.db.prepare('SELECT o.*,t.teamId FROM outbox o JOIN tasks t ON t.id=o.taskId WHERE nextAttempt<=? ORDER BY taskId LIMIT 10').all(Date.now()); }
  delivered(task, ts) {
    this.db.prepare('UPDATE tasks SET messageTs=? WHERE id=?').run(ts, task.id);
    // A status change during delivery must remain queued for a fresh update.
    this.db.prepare('DELETE FROM outbox WHERE taskId=? AND (SELECT version FROM tasks WHERE id=?)=?').run(task.id, task.id, task.version);
  }
  deliveryFailed(id, error, retryAfter = 0) {
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,error=?,nextAttempt=? + min(300000,1000 * (1 << min(attempts,8))) WHERE taskId=?').run(error, Date.now() + retryAfter, id);
  }
  pendingNotifications() {
    return this.db.prepare(`SELECT t.* FROM completion_notifications n JOIN tasks t ON t.id=n.taskId
      WHERE n.sentTs IS NULL AND n.nextAttempt<=? AND t.messageTs IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.taskId=t.id) ORDER BY t.id LIMIT 10`).all(Date.now());
  }
  notificationDelivered(id, ts) {
    this.db.prepare('UPDATE completion_notifications SET sentTs=?,error=NULL WHERE taskId=?').run(ts, id);
  }
  notificationFailed(id, error, retryAfter = 0) {
    this.db.prepare('UPDATE completion_notifications SET attempts=attempts+1,error=?,nextAttempt=? + min(300000,1000 * (1 << min(attempts,8))) WHERE taskId=?').run(error, Date.now() + retryAfter, id);
  }
}
