
export class TaskError extends Error {}
export const statuses = ['todo', 'done'];
export const labels = { todo: 'To do', done: 'Done' };
export function isTaskArchived(task,now=new Date()) {
  if(task.deletedAt||task.archivedAt)return true;
  if(task.status!=='done'||!task.completedAt)return false;
  const until=task.creatorCurrentUntil?Date.parse(task.creatorCurrentUntil):Date.parse(task.completedAt)+7*24*60*60*1000;
  return until<=now.getTime();
}
// Used until Relay knows someone's Slack time zone (and for older Eastern-only deadlines).
export const dueTimezone = process.env.TASK_TIMEZONE || 'America/New_York';
export const dueTimezoneLabel = dueTimezone === 'America/New_York' ? 'Eastern time' : dueTimezone;
export function validTimeZone(timeZone) {
  try { return Boolean(timeZone) && Boolean(new Intl.DateTimeFormat('en-US',{timeZone})); } catch { return false; }
}
const clocks = new Map();
// The calendar date and 24-hour time of a moment in a time zone.
export function clockParts(date, timeZone = dueTimezone) {
  if (!clocks.has(timeZone)) clocks.set(timeZone, new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));
  const parts = Object.fromEntries(clocks.get(timeZone).formatToParts(date).map(part=>[part.type,part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
// The UTC moment, in Unix seconds, when a wall-clock date and time happen in a time zone.
export function zonedMoment(date, time, timeZone = dueTimezone) {
  const wall = Date.parse(`${date}T${time}:00Z`);
  let moment = wall;
  // Subtract the zone's offset; the second pass settles daylight-saving changes.
  for (let pass = 0; pass < 2; pass++) { const local = clockParts(new Date(moment), timeZone); moment = wall - (Date.parse(`${local.date}T${local.time}:00Z`) - moment); }
  // A time skipped by the spring-forward change (e.g. 2:30 AM) moves forward by the gap, as clocks do.
  const local = clockParts(new Date(moment), timeZone), gap = wall - Date.parse(`${local.date}T${local.time}:00Z`);
  return (moment + Math.max(0, gap)) / 1000;
}
// A readable zone name for the viewer, such as "Pacific Daylight Time".
export function zoneLabel(timeZone = dueTimezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-US',{timeZone,timeZoneName:'long'}).formatToParts(now).find(part=>part.type==='timeZoneName')?.value ?? timeZone;
}
// The moment a timed deadline falls due; older rows without dueAt were entered in the default zone.
const dueMoment = task => task.dueAt ?? (task.dueDate && task.dueTime ? zonedMoment(task.dueDate, task.dueTime, task.dueZone || dueTimezone) : null);
// The deadline's date and time on a given clock (time is null for date-only deadlines).
export function dueInZone(task, timeZone = dueTimezone) {
  if (!task?.dueDate) return { date: null, time: null };
  const moment = dueMoment(task);
  return moment ? clockParts(new Date(moment * 1000), timeZone) : { date: task.dueDate, time: null };
}
export function formatDue(task,{now=new Date(),markOverdue=false,timeZone=dueTimezone}={}) {
  if(!task.dueDate)return '—';
  // A timed deadline is one moment shown in the viewer's zone; a date-only deadline reads the same everywhere.
  const moment=dueMoment(task);
  const {date,time}=moment?clockParts(new Date(moment*1000),timeZone):{date:task.dueDate,time:null};
  const hour=time?Number(time.slice(0,2)):0;
  const displayTime=time?`${hour%12||12}:${time.slice(3)} ${hour<12?'AM':'PM'}`:'';
  const result=date.slice(5).replace('-','/')+(displayTime?' '+displayTime:'');
  const overdue=task.status==='todo'&&!task.archivedAt&&!task.deletedAt&&(moment?now.getTime()/1000>moment:date<clockParts(now,timeZone).date);
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
  // A time is entered in its author's zone; keeping that zone lets every later check land on the same moment.
  const dueZone = dueTime ? (validTimeZone(input.dueZone) ? input.dueZone : dueTimezone) : null;
  return { title, assigneeId: input.assigneeId, dueDate, dueTime, dueZone, dueAt: dueTime ? zonedMoment(dueDate, dueTime, dueZone) : null };
}

const weekdayNames = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const monthNames = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const dueExamples = 'Try --due fri 5pm, --due tomorrow, --due 11/6, --due nov 6 at noon, or --due 11/06 5:30 PM.';
const isoDay = (year, month, day) => `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
const realDay = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso) && Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0,10) === iso;
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 864e5).toISOString().slice(0,10);
// Reads a time starting at words[i]: 5pm, 5:30pm, 5 pm, 5:30 PM, 17:30, or noon. Returns the 24-hour time and words used.
function readTime(words, i) {
  const word = (words[i] ?? '').toLowerCase(), next = (words[i + 1] ?? '').toLowerCase();
  if (word === 'noon') return { time: '12:00', used: 1 };
  let match = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(word), used = 1;
  if (!match && /^(am|pm)$/.test(next)) { match = /^(\d{1,2})(?::(\d{2}))?$/.exec(word); match &&= [...match.slice(0, 3), next]; used = 2; }
  if (match) {
    const [, hour, minute = '00', period] = match;
    if (Number(hour) < 1 || Number(hour) > 12 || Number(minute) > 59) throw new TaskError('Use a real due time, like 5pm, 5:30 PM, or 17:30.');
    return { time: `${String(Number(hour) % 12 + (period === 'pm' ? 12 : 0)).padStart(2,'0')}:${minute}`, used };
  }
  match = /^(\d{1,2}):(\d{2})$/.exec(word);
  if (match) {
    if (Number(match[1]) > 23 || Number(match[2]) > 59) throw new TaskError('Use a real due time, like 5pm, 5:30 PM, or 17:30.');
    return { time: `${match[1].padStart(2,'0')}:${match[2]}`, used: 1 };
  }
  return null;
}
// Reads a deadline from the words after --due, judged on the author's own clock: today, tomorrow, a weekday,
// 11/6, 11/6/27, nov 6, or 2026-11-06, then optionally "at" and a time. A time alone means its next occurrence.
// Dates without a year take the nearest one still ahead (February 29 waits for a leap year).
export function readDeadline(words, { now = new Date(), timeZone = dueTimezone } = {}) {
  const local = clockParts(now, timeZone), word = k => (words[k] ?? '').toLowerCase().replace(/,$/, '');
  const ahead = (day, time) => time ? `${day} ${time}` > `${local.date} ${local.time}` : day >= local.date;
  let i = 0, date = null, match;
  if (word(0) === 'today') { date = { days: 0 }; i = 1; }
  else if (['tomorrow', 'tmrw', 'tmr'].includes(word(0))) { date = { days: 1 }; i = 1; }
  else if (word(0) in weekdayNames) { date = { weekday: weekdayNames[word(0)] }; i = 1; }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(word(0))) { date = { iso: word(0) }; i = 1; }
  else if ((match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(word(0)))) { date = { month: +match[1], day: +match[2], year: match[3] }; i = 1; }
  else if (word(0) in monthNames && (match = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(word(1)))) {
    date = { month: monthNames[word(0)], day: +match[1] }; i = 2;
    if (/^\d{4}$/.test(word(2))) { date.year = word(2); i = 3; }
  }
  const at = date && word(i) === 'at' && readTime(words, i + 1);
  const timed = at || readTime(words, i);
  if (timed) i += timed.used + (at ? 1 : 0);
  const time = timed?.time ?? null;
  if (!date && !time) throw new TaskError(`Couldn't read that due date. ${dueExamples}`);
  let day;
  if (!date) day = ahead(local.date, time) ? local.date : addDays(local.date, 1);
  else if ('days' in date) day = addDays(local.date, date.days);
  else if ('weekday' in date) {
    day = addDays(local.date, (date.weekday - new Date(`${local.date}T00:00:00Z`).getUTCDay() + 7) % 7);
    if (!ahead(day, time)) day = addDays(day, 7);
  } else if (date.iso) day = date.iso;
  else if (date.year) day = isoDay(date.year.length === 2 ? 2000 + Number(date.year) : date.year, date.month, date.day);
  else {
    const thisYear = Number(local.date.slice(0, 4));
    for (let year = thisYear; year <= thisYear + 8 && !day; year++) { const candidate = isoDay(year, date.month, date.day); if (realDay(candidate) && ahead(candidate, time)) day = candidate; }
  }
  if (!day || !realDay(day)) throw new TaskError(`Use a real due date. ${dueExamples}`);
  return { dueDate: day, dueTime: time, used: i };
}

export function parseTask(text, {now=new Date(),timeZone=dueTimezone}={}) {
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
  const dueFlags = [...title.matchAll(/(?:^|\s)--due(?=\s|$)/g)];
  if (dueFlags.length > 1) throw new TaskError('Use --due only once per task.');
  if (dueFlags.length) {
    // The deadline is the words right after --due; anything after them stays in the title.
    const flag = dueFlags[0], words = title.slice(flag.index + flag[0].length).trim().split(/\s+/).filter(Boolean);
    const due = readDeadline(words, { now, timeZone });
    ({ dueDate, dueTime } = due);
    title = (title.slice(0, flag.index) + ' ' + words.slice(due.used).join(' ')).trim();
  }
  // Older saved commands pair an ISO --due date with --at HH:MM.
  const at = title.match(/(?:^|\s)--at\s+(\S+)/);
  if (at) {
    if (dueTime) throw new TaskError('Include the time in --due, like --due fri 5pm.');
    dueTime = at[1]; title = title.replace(at[0], ' ').trim();
  }
  if (title.includes('--')) throw new TaskError('Supported options: --due (like --due fri 5pm) and --details "Requirements or notes".');
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
  constructor(database) {
    this.db = database;
    // In memory only: where each person last was in Relay Home, and whose Home now shows an outdated task.
    this.homeViews = new Map();
    this.staleHomes = new Map();
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
      CREATE TABLE IF NOT EXISTS user_time_zones (userId TEXT PRIMARY KEY, timeZone TEXT, checkedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders_sent (key TEXT PRIMARY KEY, sentAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reminder_settings (userId TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
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
    this.transaction(() => {
      if(this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('archive-only'))return;
      const legacy=this.db.prepare('SELECT id FROM tasks WHERE deletedAt IS NOT NULL').all();
      this.db.exec("DELETE FROM completion_notifications WHERE sentTs IS NULL AND taskId IN (SELECT id FROM tasks WHERE deletedAt IS NOT NULL)");
      this.db.exec("UPDATE tasks SET archivedAt=coalesce(archivedAt,deletedAt),deletedAt=NULL,creatorCurrentUntil=NULL,version=version+1 WHERE deletedAt IS NOT NULL");
      for(const task of legacy)this.enqueue(task.id);
      this.db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('archive-only');
    });
    this.transaction(() => {
      if(this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('card-no-reopen'))return;
      // Refresh posted Done cards so they drop the retired Reopen button.
      for(const task of this.db.prepare("SELECT id FROM tasks WHERE status='done' AND messageTs IS NOT NULL").all())this.enqueue(task.id);
      this.db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('card-no-reopen');
    });
    this.transaction(() => {
      if(this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('send-back-mentions'))return;
      if(!this.db.prepare('PRAGMA table_info(completion_notifications)').all().some(c=>c.name==='kind'))this.db.exec("ALTER TABLE completion_notifications ADD COLUMN kind TEXT NOT NULL DEFAULT 'complete'");
      this.db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('send-back-mentions');
    });
    if(!this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('cardless-tasks')) {
      // Tasks made in Relay Home have no channel, so channelId must allow NULL. Swapping the table needs foreign keys off.
      this.db.exec('PRAGMA foreign_keys=OFF');
      try {
        this.transaction(() => {
          this.db.exec(`CREATE TABLE tasks_cardless (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              teamId TEXT NOT NULL, channelId TEXT,
              title TEXT NOT NULL, assigneeId TEXT NOT NULL, creatorId TEXT NOT NULL,
              dueDate TEXT, requiresReview INTEGER NOT NULL,
              status TEXT NOT NULL DEFAULT 'todo', version INTEGER NOT NULL DEFAULT 0,
              createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, messageTs TEXT,
              lastComment TEXT, deletedAt TEXT, dueTime TEXT,
              details TEXT NOT NULL DEFAULT '', images TEXT NOT NULL DEFAULT '[]',
              completedAt TEXT, archivedAt TEXT, creatorCurrentUntil TEXT
            );
            INSERT INTO tasks_cardless SELECT id,teamId,channelId,title,assigneeId,creatorId,dueDate,requiresReview,status,version,createdAt,updatedAt,messageTs,lastComment,deletedAt,dueTime,details,images,completedAt,archivedAt,creatorCurrentUntil FROM tasks;
            DROP TABLE tasks;
            ALTER TABLE tasks_cardless RENAME TO tasks;
            CREATE INDEX tasks_team_channel ON tasks(teamId, channelId);`);
          if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Task migration found broken references.');
          this.db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('cardless-tasks');
        });
      } finally { this.db.exec('PRAGMA foreign_keys=ON'); }
    }
    this.transaction(() => {
      if(this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('due-moments'))return;
      // Timed deadlines become one UTC moment; everything entered so far used the default (Eastern) zone.
      const columns=this.db.prepare('PRAGMA table_info(tasks)').all().map(c=>c.name);
      if(!columns.includes('dueAt'))this.db.exec('ALTER TABLE tasks ADD COLUMN dueAt INTEGER');
      if(!columns.includes('dueZone'))this.db.exec('ALTER TABLE tasks ADD COLUMN dueZone TEXT');
      const update=this.db.prepare('UPDATE tasks SET dueAt=?,dueZone=? WHERE id=?');
      // Refresh those cards too, so their deadline shows in each reader's own time.
      for(const task of this.db.prepare('SELECT id,dueDate,dueTime FROM tasks WHERE dueDate IS NOT NULL AND dueTime IS NOT NULL').all()){update.run(zonedMoment(task.dueDate,task.dueTime,dueTimezone),dueTimezone,task.id);this.enqueue(task.id);}
      this.db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run('due-moments');
    });
  }
  // A person's Slack time zone, or the default zone until Relay has learned it.
  timeZoneOf(userId) {
    return this.db.prepare('SELECT timeZone FROM user_time_zones WHERE userId=?').get(userId)?.timeZone || dueTimezone;
  }
  // Re-check a known zone daily (people travel), and an unknown one hourly (e.g. until users:read is approved).
  timeZoneDue(userId, now = Date.now()) {
    const row = this.db.prepare('SELECT timeZone,checkedAt FROM user_time_zones WHERE userId=?').get(userId);
    return !row || now - row.checkedAt > (row.timeZone ? 24 : 1) * 60 * 60 * 1000;
  }
  // Reminders are on unless the person turned them off in Relay Home.
  remindersOn(userId) {
    return (this.db.prepare('SELECT enabled FROM reminder_settings WHERE userId=?').get(userId)?.enabled ?? 1) === 1;
  }
  setReminders(userId, enabled) {
    this.db.prepare('INSERT INTO reminder_settings(userId,enabled) VALUES (?,?) ON CONFLICT(userId) DO UPDATE SET enabled=excluded.enabled').run(userId, enabled ? 1 : 0);
  }
  // Each reminder is keyed by what it is about, so it is sent at most once, even across restarts.
  reminderSent(key) { return Boolean(this.db.prepare('SELECT 1 FROM reminders_sent WHERE key=?').get(key)); }
  markReminderSent(key, now = Date.now()) { this.db.prepare('INSERT OR IGNORE INTO reminders_sent(key,sentAt) VALUES (?,?)').run(key, now); }
  // Unfinished, active work, across every workspace this database serves.
  openTasks() { return this.db.prepare("SELECT * FROM tasks WHERE status='todo' AND archivedAt IS NULL AND deletedAt IS NULL ORDER BY id").all(); }
  saveTimeZone(userId, timeZone, now = Date.now()) {
    this.db.prepare('INSERT INTO user_time_zones(userId,timeZone,checkedAt) VALUES (?,?,?) ON CONFLICT(userId) DO UPDATE SET timeZone=coalesce(excluded.timeZone,user_time_zones.timeZone),checkedAt=excluded.checkedAt').run(userId, validTimeZone(timeZone) ? timeZone : null, now);
  }
  close() { this.db.close(); }
  transaction(fn) {
    if(this.db.transaction)return this.db.transaction(fn);
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id, teamId) { return this.db.prepare('SELECT * FROM tasks WHERE id=? AND teamId=?').get(id, teamId); }
  receipt(key) { return this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key); }
  enqueue(id) {
    // Only tasks with a channel card have a message to post or update.
    this.db.prepare('INSERT INTO outbox(taskId) SELECT id FROM tasks WHERE id=? AND channelId IS NOT NULL ON CONFLICT(taskId) DO UPDATE SET attempts=0,nextAttempt=0,error=NULL').run(id);
  }
  markStale(task, ...others) {
    for (const userId of [task.creatorId, task.assigneeId, ...others]) if (userId) this.staleHomes.set(userId, task.teamId);
  }
  // Queues a mention of the person who didn't make the change. Nobody is notified about their own task.
  notice(task, version, kind, title = task.title, assigneeId = task.assigneeId) {
    if (assigneeId === task.creatorId) return;
    this.db.prepare('INSERT OR IGNORE INTO completion_notifications(taskId,version,title,creatorId,assigneeId,kind) VALUES (?,?,?,?,?,?)').run(task.id, version, title, task.creatorId, assigneeId, kind);
  }
  create(input, receiptKey) {
    return this.transaction(() => {
      if (receiptKey && this.receipt(receiptKey)) return this.get(this.receipt(receiptKey).taskId, input.teamId);
      input = { ...input, ...validateTask(input), ...validateDetails(input.details??'',input.images??[]) };
      const now = new Date().toISOString();
      const result = this.db.prepare(`INSERT INTO tasks(teamId,channelId,title,assigneeId,creatorId,dueDate,dueTime,dueZone,dueAt,details,images,requiresReview,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.teamId, input.channelId ?? null, input.title, input.assigneeId, input.creatorId, input.dueDate ?? null, input.dueTime ?? null, input.dueZone, input.dueAt, input.details, JSON.stringify(input.images), 0, now, now);
      const id = Number(result.lastInsertRowid);
      this.db.prepare('INSERT INTO history(taskId,actorId,action,createdAt) VALUES (?,?,?,?)').run(id, input.creatorId, 'created', now);
      if (receiptKey) this.db.prepare('INSERT INTO receipts(key,taskId) VALUES (?,?)').run(receiptKey, id);
      // A channel card mentions the assignee; without one they hear about the task by DM.
      if (input.channelId) this.enqueue(id);
      else this.notice(this.get(id, input.teamId), 0, 'assign');
      this.markStale(input);
      return this.get(id, input.teamId);
    });
  }
  transition({ id, teamId, channelId, actorId, action, version, receiptKey }) {
    return this.transaction(() => {
      const task = this.get(id, teamId);
      // Card buttons pass their channel and must match the task's card; Relay Home passes none.
      if (!task || (channelId !== undefined && task.channelId !== channelId)) throw new TaskError('That task is not available in this channel.');
      if (receiptKey && this.receipt(receiptKey)) return task;
      if (version !== undefined && task.version !== version) throw new TaskError('This card has changed. Use its latest buttons, or run /tasks mine for the current status.');
      if (task.deletedAt) throw new TaskError('This task is archived. Its assigner can move it to Current from Past.');
      if(task.status==='todo'&&task.archivedAt)throw new TaskError('This task was archived. Its assigner can move it to Current before work resumes.');
      const canComplete = action === 'complete' && task.status === 'todo' && [task.assigneeId, task.creatorId].includes(actorId);
      // Either person can mark work Done; only the assigner sends unarchived Done work back to To do.
      const canReopen = action === 'reopen' && task.status === 'done' && actorId === task.creatorId && !isTaskArchived(task);
      if (action === 'reopen' && task.status === 'done' && actorId === task.creatorId && !canReopen) throw new TaskError('This task is archived. Set it to Active before sending it back to To do.');
      if (action === 'reopen' && !canReopen) throw new TaskError('This action is unavailable. Only the assigner can send a Done task back to To do.');
      if (!canComplete && !canReopen) throw new TaskError('This action is unavailable. Only the assignee or assigner can mark this task done.');
      const now = new Date().toISOString();
      this.db.prepare('UPDATE tasks SET status=?,completedAt=?,archivedAt=NULL,creatorCurrentUntil=NULL,version=version+1,updatedAt=? WHERE id=?').run(canComplete ? 'done' : 'todo', canComplete?now:null, now, id);
      this.db.prepare('INSERT INTO history(taskId,actorId,action,createdAt) VALUES (?,?,?,?)').run(id, actorId, action, now);
      // Only the latest status change is announced: an unsent mention for the previous one is dropped.
      this.db.prepare('DELETE FROM completion_notifications WHERE taskId=? AND sentTs IS NULL').run(id);
      // The other person hears about it: the assigner when the assignee finishes, the assignee when the assigner closes or reopens.
      this.notice(task, task.version+1, !canComplete ? 'reopen' : actorId === task.assigneeId ? 'complete' : 'closed');
      if (receiptKey) this.db.prepare('INSERT INTO receipts(key,taskId) VALUES (?,?)').run(receiptKey, id);
      this.enqueue(id);
      this.markStale(task);
      return this.get(id, teamId);
    });
  }
  list({ teamId, channelId, userId, mode = 'team', includeDone = false }) {
    // Your own lists cover all your tasks; team lists cover tasks whose card is in this channel.
    const personal = ['mine', 'assigned'].includes(mode);
    let sql = `SELECT * FROM tasks WHERE teamId=?${personal ? '' : ' AND channelId=?'} AND deletedAt IS NULL`;
    const args = personal ? [teamId] : [teamId, channelId];
    if (mode === 'mine') { sql += ' AND assigneeId=?'; args.push(userId); }
    if (mode === 'assigned') { sql += ' AND creatorId=?'; args.push(userId); }
    if (!includeDone) sql += " AND status!='done' AND archivedAt IS NULL";
    return this.db.prepare(sql + ' ORDER BY createdAt DESC,id DESC LIMIT 50').all(...args);
  }
  history(id) { return this.db.prepare('SELECT * FROM history WHERE taskId=? ORDER BY id').all(id); }
  personalPage({ teamId, userId, direction, page = 0, othersOnly = false, filter = 'all', size = 20, recentFirst = false, period = 'all', now = new Date() }) {
    if (!teamId || !userId || !['mine', 'assigned', 'trash'].includes(direction) || !['todo','done','all'].includes(filter) || !['current','past','all'].includes(period)) throw new TaskError('Invalid personal task query.');
    const column = direction === 'mine' ? 'assigneeId' : 'creatorId';
    let where = `teamId=? AND ${column}=?${direction === 'assigned' && othersOnly ? ' AND assigneeId!=?' : ''} AND deletedAt IS ${direction === 'trash' ? 'NOT ' : ''}NULL${direction !== 'trash' && filter !== 'all' ? ' AND status=?' : ''}`;
    const args = [teamId, userId, ...(direction === 'assigned' && othersOnly ? [userId] : [])];
    if (direction !== 'trash' && filter !== 'all') args.push(filter);
    if(period!=='all'&&direction!=='trash') {
      const role = direction==='mine'?'assigneeId':'creatorId';
      const current = direction==='mine' ? "deletedAt IS NULL AND archivedAt IS NULL AND status='todo'" : "deletedAt IS NULL AND archivedAt IS NULL AND (status='todo' OR coalesce(creatorCurrentUntil,strftime('%Y-%m-%dT%H:%M:%fZ',completedAt,'+7 days'))>?)";
      where=`teamId=? AND ${role}=? AND ${period==='past'?'NOT ':''}(${current})`;
      args.length=0;args.push(teamId,userId);if(direction==='assigned')args.push(now.toISOString());
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
  // Slack can't post or update this card (deleted, or Relay can't post there): keep the task and stop referencing a message.
  detachCard(id) {
    this.transaction(() => {
      const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (!task?.channelId) return;
      this.db.prepare('UPDATE tasks SET channelId=NULL,messageTs=NULL WHERE id=?').run(id);
      this.db.prepare('DELETE FROM outbox WHERE taskId=?').run(id);
      // A card that was never posted never mentioned the assignee, so tell them directly.
      if (!task.messageTs && task.status === 'todo' && !task.archivedAt) this.notice(task, task.version, 'assign');
    });
  }
  deliveryFailed(id, error, retryAfter = 0) {
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,error=?,nextAttempt=? + min(300000,1000 * (1 << min(attempts,8))) WHERE taskId=?').run(error, Date.now() + retryAfter, id);
  }
  pendingNotifications() {
    return this.db.prepare(`SELECT t.id,t.teamId,t.channelId,t.messageTs,n.id AS notificationId,n.kind,n.title,n.assigneeId,n.creatorId FROM completion_notifications n JOIN tasks t ON t.id=n.taskId
      WHERE n.sentTs IS NULL AND n.nextAttempt<=? AND t.deletedAt IS NULL
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.taskId=t.id) ORDER BY t.id LIMIT 10`).all(Date.now());
  }
  notificationDelivered(id, ts) {
    this.db.prepare('UPDATE completion_notifications SET sentTs=?,error=NULL WHERE id=?').run(ts, id);
  }
  notificationFailed(id, error, retryAfter = 0) {
    this.db.prepare('UPDATE completion_notifications SET attempts=attempts+1,error=?,nextAttempt=? + min(300000,1000 * (1 << min(attempts,8))) WHERE id=?').run(error, Date.now() + retryAfter, id);
  }
  // The recipient can never receive this (e.g. deactivated); keep the error but stop retrying.
  notificationDropped(id, error) {
    this.db.prepare('UPDATE completion_notifications SET attempts=attempts+1,error=?,nextAttempt=? WHERE id=?').run(error, Number.MAX_SAFE_INTEGER, id);
  }
  manage({ id, teamId, channelId, actorId, version, action, changes, receiptKey }) {
    action=action==='delete'?'archive':action==='restore'?'unarchive':action;
    return this.transaction(() => {
      const task = this.get(id, teamId);
      if (!task || (channelId !== undefined && task.channelId !== channelId) || task.creatorId !== actorId) throw new TaskError('Only the assigner can edit, archive, or reactivate this task.');
      if (receiptKey && this.receipt(receiptKey)) return task;
      if (!Number.isSafeInteger(version) || version !== task.version) throw new TaskError('This task changed. Refresh the task list and try again.');
      const now = new Date().toISOString();
      if (action === 'edit' && !task.deletedAt) {
        const data = validateTask(changes);
        const extra=validateDetails(changes.details??task.details,changes.images??taskImages(task));
        this.db.prepare('UPDATE tasks SET title=?,assigneeId=?,dueDate=?,dueTime=?,dueZone=?,dueAt=?,details=?,images=?,version=version+1,updatedAt=? WHERE id=?').run(data.title,data.assigneeId,data.dueDate,data.dueTime,data.dueZone,data.dueAt,extra.details,JSON.stringify(extra.images),now,id);
        if (data.assigneeId !== task.assigneeId) {
          // Editing a card notifies no one, so a new assignee of active work gets a mention; an unsent one for the previous assignee is dropped.
          this.db.prepare("DELETE FROM completion_notifications WHERE taskId=? AND kind='assign' AND sentTs IS NULL").run(id);
          if (task.status === 'todo' && !task.archivedAt) this.notice(task, task.version+1, 'assign', data.title, data.assigneeId);
        }
      } else if (['archive','unarchive'].includes(action)) {
        this.db.prepare('UPDATE tasks SET deletedAt=NULL,archivedAt=?,creatorCurrentUntil=?,version=version+1,updatedAt=? WHERE id=?').run(action==='archive'?now:null,action==='unarchive'&&task.status==='done'?new Date(Date.parse(now)+7*24*60*60*1000).toISOString():null,now,id);
      } else throw new TaskError('This action is unavailable for the task’s current state.');
      this.db.prepare('INSERT INTO history(taskId,actorId,action,createdAt) VALUES (?,?,?,?)').run(id,actorId,action,now);
      if (receiptKey) this.db.prepare('INSERT INTO receipts(key,taskId) VALUES (?,?)').run(receiptKey,id);
      this.enqueue(id);
      // A reassignment also changes the new assignee's Home.
      this.markStale(task, changes?.assigneeId);
      return this.get(id,teamId);
    });
  }
}
