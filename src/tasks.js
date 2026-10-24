import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class TaskError extends Error {}
export const statuses = ['todo', 'done'];
export const labels = { todo: 'To do', done: 'Done' };
export const dueTimezone = process.env.TASK_TIMEZONE || 'America/New_York';
export const dueTimezoneLabel = dueTimezone === 'America/New_York' ? 'Eastern time' : dueTimezone;
const dueClock = new Intl.DateTimeFormat('en-CA',{timeZone:dueTimezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function formatDue(task,{now=new Date(),markOverdue=false}={}) {
  if(!task.dueDate)return '—';
  const hour=task.dueTime?Number(task.dueTime.slice(0,2)):0;
  const displayTime=task.dueTime?`${hour%12||12}:${task.dueTime.slice(3)} ${hour<12?'AM':'PM'}`:'';
  const result=task.dueDate.slice(5).replace('-','/')+(displayTime?' '+displayTime:'');
  const parts=Object.fromEntries(dueClock.formatToParts(now).map(part=>[part.type,part.value]));
  const today=`${parts.year}-${parts.month}-${parts.day}`,time=`${parts.hour}:${parts.minute}`;
  const overdue=task.status==='todo'&&(task.dueDate<today||(task.dueDate===today&&task.dueTime&&task.dueTime<time));
  return (markOverdue&&overdue?'Overdue · ':'')+result;
}
export function validateTask(input) {
  const title = String(input.title ?? '').trim();
  if (!title || title.length > 240) throw new TaskError('Give the task a title between 1 and 240 characters.');
  if (!/^[UW][A-Z0-9]+$/.test(input.assigneeId ?? '')) throw new TaskError('Choose a teammate.');
  const dueDate = input.dueDate || null;
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate)) throw new TaskError('Use a real due date in YYYY-MM-DD format.');
  const dueTime = input.dueTime || null;
  if(dueTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dueTime))throw new TaskError('Use a real due time in HH:MM format (00:00–23:59).');
  if(dueTime && !dueDate)throw new TaskError('Choose a due date before setting a time.');
  return { title, assigneeId: input.assigneeId, dueDate, dueTime };
}

export function parseTask(text, {now=new Date()}={}) {
  const match = text.trim().match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>\s+(.+)$/s);
  if (!match) throw new TaskError('Use /task @someone Task title --due MM/DD HH:MM AM/PM. Select the person from Slack’s suggestions.');
  let title = match[2].trim();
  let details;
  const detailsFlag=/(?:^|\s)--details(?=\s|$)/.exec(title);
  if(detailsFlag) {
    const start=detailsFlag.index+detailsFlag[0].length;
    let cursor=start;while(/\s/.test(title[cursor]??'')&&cursor<title.length)cursor++;
    const quote=title[cursor],closing=quote==='“'?'”':'"';
    if(!['"','“'].includes(quote))throw new TaskError('Put details in quotes: --details "Requirements or notes".');
    let value='',closed=false;cursor++;
    for(;cursor<title.length;cursor++) {
      const character=title[cursor];
      if(character===closing){closed=true;cursor++;break;}
      if(character==='\\'&&['"','\\'].includes(title[cursor+1]))value+=title[++cursor];
      else value+=character;
    }
    if(!closed||(cursor<title.length&&!/\s/.test(title[cursor])))throw new TaskError('Close the quotes around --details "Requirements or notes".');
    details=validateDetails(value).details;
    title=(title.slice(0,detailsFlag.index)+' '+title.slice(cursor)).trim();
    if(/(?:^|\s)--details(?=\s|$)/.test(title))throw new TaskError('Use --details only once per task.');
  }
  // Accept the former flag on old saved commands; completion is now always direct.
  title = title.replace(/(?:^|\s)--no-review(?=\s|$)/g, ' ').trim();
  let dueDate = null, dueTime = null;
  const shortDue = title.match(/(?:^|\s)--due\s+(\d{2})\/(\d{2})\s+(\d{1,2}):([0-5]\d)\s+(AM|PM)(?=\s|$)/i);
  if (shortDue) {
    const [,month,day,hour,minute,period] = shortDue;
    if (Number(hour)<1 || Number(hour)>12) throw new TaskError('Use --due MM/DD HH:MM AM/PM, with an hour from 1 to 12.');
    dueTime = `${String(Number(hour)%12+(period.toUpperCase()==='PM'?12:0)).padStart(2,'0')}:${minute}`;
    const parts = Object.fromEntries(dueClock.formatToParts(now).map(part=>[part.type,part.value]));
    const current = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    // Search through the next leap-year cycle so February 29 works too.
    for(let year=Number(parts.year);year<=Number(parts.year)+8;year++) {
      const candidate = `${year}-${month}-${day}`;
      const parsed = new Date(candidate);
      if(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10)===candidate && `${candidate} ${dueTime}`>current) { dueDate=candidate; break; }
    }
    if(!dueDate) throw new TaskError('Use a real due date: --due MM/DD HH:MM AM/PM.');
    title=title.replace(shortDue[0],' ').trim();
    if(/(?:^|\s)--at(?:\s|$)/.test(title)) throw new TaskError('Include the time in --due MM/DD HH:MM AM/PM.');
  } else {
    // Keep older ISO commands working, including saved commands and demo input.
    const due = title.match(/(?:^|\s)--due\s+(\S+)/);
    if(due) {
      dueDate=due[1];
      if(!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0,10)!==dueDate) throw new TaskError('Use a real due date: --due MM/DD HH:MM AM/PM.');
      title=title.replace(due[0],' ').trim();
    }
    const at=title.match(/(?:^|\s)--at\s+(\S+)/);
    if(at){dueTime=at[1];title=title.replace(at[0],' ').trim();}
  }
  if (title.includes('--')) throw new TaskError('Supported options: --due MM/DD HH:MM AM/PM and --details "Requirements or notes".');
  validateTask({title,assigneeId:match[1],dueDate,dueTime});
  if (!title || title.length > 240) throw new TaskError('Give the task a title between 1 and 240 characters.');
  return { assigneeId: match[1], title, dueDate, ...(dueTime?{dueTime}:{}), ...(details!==undefined?{details}:{}) };
}

export function taskImages(task={}) {
  try { return JSON.parse(task.images || '[]'); } catch { return []; }
}
export function validateDetails(details, images=[]) {
  if(typeof details!=='string'||details.length>3000)throw new TaskError('Keep task details under 3,000 characters.');
  if(!Array.isArray(images)||images.length>5||images.some(id=>typeof id!=='string'||!/^F[A-Z0-9]+$/.test(id)))throw new TaskError('Attach up to five images.');
  return {details:details.trim(),images:[...new Set(images)]};
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
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('app-ui')) return;
      if (!this.db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='deletedAt')) this.db.exec('ALTER TABLE tasks ADD COLUMN deletedAt TEXT');
      if (!this.db.prepare('PRAGMA table_info(completion_notifications)').all().some(c=>c.name==='version')) this.db.exec(`ALTER TABLE completion_notifications RENAME TO legacy_completion_notifications;
        CREATE TABLE completion_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,taskId INTEGER NOT NULL REFERENCES tasks(id),version INTEGER NOT NULL,
          title TEXT NOT NULL,creatorId TEXT NOT NULL,assigneeId TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,nextAttempt INTEGER NOT NULL DEFAULT 0,error TEXT,sentTs TEXT,
          UNIQUE(taskId,version)
        );
        INSERT INTO completion_notifications(taskId,version,title,creatorId,assigneeId,attempts,nextAttempt,error,sentTs)
          SELECT t.id,t.version,t.title,t.creatorId,t.assigneeId,n.attempts,n.nextAttempt,n.error,n.sentTs
          FROM legacy_completion_notifications n JOIN tasks t ON t.id=n.taskId;
        DROP TABLE legacy_completion_notifications;`);
      for (const task of this.db.prepare('SELECT id FROM tasks').all()) this.enqueue(task.id);
      this.db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('app-ui');
    });
    this.transaction(() => {
      if(this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('due-time'))return;
      if(!this.db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='dueTime'))this.db.exec('ALTER TABLE tasks ADD COLUMN dueTime TEXT');
      for(const task of this.db.prepare('SELECT id FROM tasks WHERE deletedAt IS NULL AND messageTs IS NOT NULL').all())this.enqueue(task.id);
      this.db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('due-time');
    });
    this.transaction(() => {
      if(this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('task-details'))return;
      const columns=this.db.prepare('PRAGMA table_info(tasks)').all().map(c=>c.name);
      if(!columns.includes('details'))this.db.exec("ALTER TABLE tasks ADD COLUMN details TEXT NOT NULL DEFAULT ''");
      if(!columns.includes('images'))this.db.exec("ALTER TABLE tasks ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
      this.db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('task-details');
    });
    this.transaction(() => {
      if(this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('task-lifecycle'))return;
      const columns=this.db.prepare('PRAGMA table_info(tasks)').all().map(c=>c.name);
      for(const name of ['completedAt','archivedAt','creatorCurrentUntil'])if(!columns.includes(name))this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} TEXT`);
      this.db.exec("UPDATE tasks SET completedAt=coalesce((SELECT max(createdAt) FROM history WHERE taskId=tasks.id AND action='complete'),updatedAt) WHERE status='done' AND completedAt IS NULL");
      this.db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('task-lifecycle');
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
      input = { ...input, ...validateTask(input), ...validateDetails(input.details??'',input.images??[]) };
      const now = new Date().toISOString();
      const result = this.db.prepare(`INSERT INTO tasks(teamId,channelId,title,assigneeId,creatorId,dueDate,dueTime,details,images,requiresReview,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.teamId, input.channelId, input.title, input.assigneeId, input.creatorId, input.dueDate ?? null, input.dueTime ?? null, input.details, JSON.stringify(input.images), 0, now, now);
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
      if (task.deletedAt) throw new TaskError('This task was deleted. Its assigner can restore it from Past.');
      const canComplete = action === 'complete' && task.status === 'todo' && actorId === task.assigneeId;
      const canReopen = action === 'reopen' && task.status === 'done' && actorId === task.assigneeId;
      if (!canComplete && !canReopen) throw new TaskError('This action is unavailable. Only the assignee can change this task’s status.');
      const now = new Date().toISOString();
      this.db.prepare('UPDATE tasks SET status=?,completedAt=?,archivedAt=NULL,creatorCurrentUntil=NULL,version=version+1,updatedAt=? WHERE id=?').run(canComplete ? 'done' : 'todo', canComplete?now:null, now, id);
      this.db.prepare('INSERT INTO history(taskId,actorId,action,createdAt) VALUES (?,?,?,?)').run(id, actorId, action, now);
      if (canComplete) this.db.prepare('INSERT INTO completion_notifications(taskId,version,title,creatorId,assigneeId) VALUES (?,?,?,?,?)').run(id,task.version+1,task.title,task.creatorId,task.assigneeId);
      else this.db.prepare('DELETE FROM completion_notifications WHERE taskId=? AND sentTs IS NULL').run(id);
      if (receiptKey) this.db.prepare('INSERT INTO receipts(key,taskId) VALUES (?,?)').run(receiptKey, id);
      this.enqueue(id);
      return this.get(id, teamId);
    });
  }
  list({ teamId, channelId, userId, mode = 'team', includeDone = false }) {
    let sql = 'SELECT * FROM tasks WHERE teamId=? AND channelId=? AND deletedAt IS NULL';
    const args = [teamId, channelId];
    if (mode === 'mine') { sql += ' AND assigneeId=?'; args.push(userId); }
    if (mode === 'assigned') { sql += ' AND creatorId=?'; args.push(userId); }
    if (!includeDone) sql += " AND status!='done'";
    return this.db.prepare(sql + ' ORDER BY createdAt DESC,id DESC LIMIT 50').all(...args);
  }
  history(id) { return this.db.prepare('SELECT * FROM history WHERE taskId=? ORDER BY id').all(id); }
  personalPage({ teamId, channelId, userId, direction, page = 0, othersOnly = false, filter = 'all', size = 20, recentFirst = false, period = 'all', now = new Date() }) {
    if (!teamId || !channelId || !userId || !['mine', 'assigned', 'trash'].includes(direction) || !['todo','done','all'].includes(filter) || !['current','past','all'].includes(period)) throw new TaskError('Invalid personal task query.');
    const column = direction === 'mine' ? 'assigneeId' : 'creatorId';
    let where = `teamId=? AND channelId=? AND ${column}=?${direction === 'assigned' && othersOnly ? ' AND assigneeId!=?' : ''} AND deletedAt IS ${direction === 'trash' ? 'NOT ' : ''}NULL${direction !== 'trash' && filter !== 'all' ? ' AND status=?' : ''}`;
    const args = [teamId, channelId, userId, ...(direction === 'assigned' && othersOnly ? [userId] : [])];
    if (direction !== 'trash' && filter !== 'all') args.push(filter);
    if(period!=='all'&&direction!=='trash') {
      const role = direction==='mine'?'assigneeId':'creatorId';
      const current = direction==='mine' ? "deletedAt IS NULL AND status='todo'" : "deletedAt IS NULL AND archivedAt IS NULL AND (status='todo' OR coalesce(creatorCurrentUntil,strftime('%Y-%m-%dT%H:%M:%fZ',completedAt,'+7 days'))>?)";
      where=`teamId=? AND channelId=? AND ${role}=? AND ${period==='past'?'NOT ':''}(${current})`;
      args.length=0;args.push(teamId,channelId,userId);if(direction==='assigned')args.push(now.toISOString());
    }
    const summary = this.db.prepare(`SELECT count(*) AS total,coalesce(sum(status='done'),0) AS done FROM tasks WHERE ${where}`).get(...args);
    size = Number.isSafeInteger(size) ? Math.max(1,Math.min(20,size)) : 20;
    const lastPage = Math.max(0, Math.ceil(summary.total / size) - 1);
    const current = Math.min(lastPage, Number.isSafeInteger(page) ? Math.max(0, page) : 0);
    const tasks = this.db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY ${period==='past'?"coalesce(deletedAt,archivedAt,completedAt,updatedAt) DESC,":''}${recentFirst ? '' : "CASE WHEN status='todo' THEN 0 ELSE 1 END,"}createdAt DESC,id DESC LIMIT ? OFFSET ?`).all(...args, size, current * size);
    return { ...summary, tasks, page: current, lastPage, size };
  }
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
    return this.db.prepare(`SELECT t.id,t.teamId,t.channelId,t.messageTs,n.id AS notificationId,n.title,n.assigneeId,n.creatorId FROM completion_notifications n JOIN tasks t ON t.id=n.taskId
      WHERE n.sentTs IS NULL AND n.nextAttempt<=? AND t.messageTs IS NOT NULL AND t.deletedAt IS NULL
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.taskId=t.id) ORDER BY t.id LIMIT 10`).all(Date.now());
  }
  notificationDelivered(id, ts) {
    this.db.prepare('UPDATE completion_notifications SET sentTs=?,error=NULL WHERE id=?').run(ts, id);
  }
  notificationFailed(id, error, retryAfter = 0) {
    this.db.prepare('UPDATE completion_notifications SET attempts=attempts+1,error=?,nextAttempt=? + min(300000,1000 * (1 << min(attempts,8))) WHERE id=?').run(error, Date.now() + retryAfter, id);
  }
  manage({ id, teamId, channelId, actorId, version, action, changes, receiptKey }) {
    return this.transaction(() => {
      const task = this.get(id, teamId);
      if (!task || task.channelId !== channelId || task.creatorId !== actorId) throw new TaskError('Only the assigner can edit, delete, or restore this task.');
      if (receiptKey && this.receipt(receiptKey)) return task;
      if (!Number.isSafeInteger(version) || version !== task.version) throw new TaskError('This task changed. Refresh the task list and try again.');
      const now = new Date().toISOString();
      if (action === 'edit' && !task.deletedAt) {
        const data = validateTask(changes);
        const extra=validateDetails(changes.details??task.details,changes.images??taskImages(task));
        this.db.prepare('UPDATE tasks SET title=?,assigneeId=?,dueDate=?,dueTime=?,details=?,images=?,version=version+1,updatedAt=? WHERE id=?').run(data.title,data.assigneeId,data.dueDate,data.dueTime,extra.details,JSON.stringify(extra.images),now,id);
      } else if (['archive','unarchive'].includes(action) && !task.deletedAt && task.status==='done') {
        this.db.prepare('UPDATE tasks SET archivedAt=?,creatorCurrentUntil=?,version=version+1,updatedAt=? WHERE id=?').run(action==='archive'?now:null,action==='unarchive'?new Date(Date.parse(now)+7*24*60*60*1000).toISOString():null,now,id);
      } else if (action === 'delete' && !task.deletedAt) {
        this.db.prepare('UPDATE tasks SET deletedAt=?,version=version+1,updatedAt=? WHERE id=?').run(now,now,id);
        this.db.prepare('DELETE FROM completion_notifications WHERE taskId=? AND sentTs IS NULL').run(id);
      } else if (action === 'restore' && task.deletedAt) {
        this.db.prepare('UPDATE tasks SET deletedAt=NULL,version=version+1,updatedAt=? WHERE id=?').run(now,id);
      } else throw new TaskError('This action is unavailable for the task’s current state.');
      this.db.prepare('INSERT INTO history(taskId,actorId,action,createdAt) VALUES (?,?,?,?)').run(id,actorId,action,now);
      if (receiptKey) this.db.prepare('INSERT INTO receipts(key,taskId) VALUES (?,?)').run(receiptKey,id);
      this.enqueue(id);
      return this.get(id,teamId);
    });
  }
}
