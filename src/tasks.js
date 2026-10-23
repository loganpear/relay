import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class TaskError extends Error {}
export const statuses = ['todo', 'in_progress', 'review', 'done'];
export const labels = { todo: 'To do', in_progress: 'In progress', review: 'Ready for review', done: 'Done' };

export function parseTask(text) {
  const match = text.trim().match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>\s+(.+)$/s);
  if (!match) throw new TaskError('Use /task @someone Task title --due YYYY-MM-DD. Select the person from Slack’s suggestions.');
  let title = match[2].trim();
  const noReview = /(?:^|\s)--no-review(?=\s|$)/.test(title);
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
  if (title.includes('--')) throw new TaskError('Supported options: --due YYYY-MM-DD and --no-review.');
  if (!title || title.length > 240) throw new TaskError('Give the task a title between 1 and 240 characters.');
  return { assigneeId: match[1], title, dueDate, requiresReview: !noReview };
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
    `);
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
        VALUES (?,?,?,?,?,?,?,?,?)`).run(input.teamId, input.channelId, input.title, input.assigneeId, input.creatorId, input.dueDate ?? null, input.requiresReview ? 1 : 0, now, now);
      const id = Number(result.lastInsertRowid);
      this.db.prepare('INSERT INTO history(taskId,actorId,action,createdAt) VALUES (?,?,?,?)').run(id, input.creatorId, 'created', now);
      if (receiptKey) this.db.prepare('INSERT INTO receipts(key,taskId) VALUES (?,?)').run(receiptKey, id);
      this.enqueue(id);
      return this.get(id, input.teamId);
    });
  }
  transition({ id, teamId, channelId, actorId, action, version, comment = null, receiptKey }) {
    return this.transaction(() => {
      const task = this.get(id, teamId);
      if (!task || task.channelId !== channelId) throw new TaskError('That task is not available in this channel.');
      if (receiptKey && this.receipt(receiptKey)) return task;
      if (version !== undefined && task.version !== version) throw new TaskError('This card has changed. Use its latest buttons, or run /tasks mine for the current status.');
      let next;
      const assignee = actorId === task.assigneeId;
      const reviewer = actorId === task.creatorId;
      if (action === 'start' && task.status === 'todo' && assignee) next = 'in_progress';
      if (action === 'ready' && ['todo', 'in_progress'].includes(task.status) && assignee && task.requiresReview) next = 'review';
      if (action === 'complete' && ['todo', 'in_progress'].includes(task.status) && assignee && !task.requiresReview) next = 'done';
      if (action === 'approve' && task.status === 'review' && reviewer) next = 'done';
      if (action === 'changes' && task.status === 'review' && reviewer) next = 'in_progress';
      if (!next) throw new TaskError('This action is unavailable. Assignees start and submit tasks; the task creator reviews them.');
      if (comment && comment.length > 500) throw new TaskError('Keep the review note under 500 characters.');
      const now = new Date().toISOString();
      this.db.prepare('UPDATE tasks SET status=?,version=version+1,updatedAt=?,lastComment=? WHERE id=?').run(next, now, comment, id);
      this.db.prepare('INSERT INTO history(taskId,actorId,action,comment,createdAt) VALUES (?,?,?,?,?)').run(id, actorId, action, comment, now);
      if (receiptKey) this.db.prepare('INSERT INTO receipts(key,taskId) VALUES (?,?)').run(receiptKey, id);
      this.enqueue(id);
      return this.get(id, teamId);
    });
  }
  list({ teamId, channelId, userId, mode = 'team', includeDone = false }) {
    let sql = 'SELECT * FROM tasks WHERE teamId=? AND channelId=?';
    const args = [teamId, channelId];
    if (mode === 'mine') { sql += ' AND assigneeId=?'; args.push(userId); }
    if (mode === 'review') { sql += " AND creatorId=? AND status='review'"; args.push(userId); }
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
}
