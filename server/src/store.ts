import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RUNNING_STATUSES, contextWindowFor } from '@garden/shared'
import type {
  Project,
  Profile,
  TerminalSession,
  AgentEvent,
  DocCard,
  Channel,
  Wire,
  WorkRecord,
  SavedLayout,
  BoardLimits,
  CardLoop,
  TaskContract,
  TaskReassignment,
  TaskState,
} from '@garden/shared'
import { DEFAULT_LIMITS } from '@garden/shared'

/** One archived Claude Code transcript, as stored by server/src/archive.ts. */
export interface TranscriptRecord {
  id: string
  sessionId: string | null
  agentId: string | null
  sourcePath: string
  slug: string
  claudeSessionId: string | null
  bytes: number
  lineCount: number
  capturedAt: number
  content: string
  meta: string | null
}

/** Same shape without the raw text, for listing without hauling megabytes of jsonl over. */
export type TranscriptSummary = Omit<TranscriptRecord, 'content'>

/**
 * Everything Garden owns lives here: the board, the mailboxes, the per-session hook settings and
 * the transcript archive.
 *
 * GARDEN_HOME moves the whole lot somewhere else, which is how a second copy of the server can run
 * beside the one the owner is using without either of them being able to reach the other's board,
 * mail or hook files. The database alone was not enough separation once wires started carrying
 * messages, because two servers sharing `mail/` write into the same inboxes.
 */
export const DATA_DIR = process.env.GARDEN_HOME || join(homedir(), '.garden')

/**
 * GARDEN_DB points the server at a different database.
 *
 * This exists so the test and screenshot harnesses never touch the owner's real workspace. An
 * earlier version of those scripts deleted the live database to get a clean board, which threw
 * away his projects and account bindings every time they ran, and looked from the outside like
 * the app forgetting which account a tab used.
 */
const DB_PATH = process.env.GARDEN_DB || join(DATA_DIR, 'garden.db')

export class Store {
  private db: Database.Database

  constructor(path = DB_PATH) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL,
        defaultAdapterId TEXT NOT NULL,
        defaultProfileId TEXT,
        notes TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL,
        lastOpenedAt INTEGER NOT NULL
      );

      -- One account per CLI per project. A Claude session and a Codex session can share a tab;
      -- two Claude accounts never can.
      CREATE TABLE IF NOT EXISTS project_profiles (
        projectId TEXT NOT NULL,
        adapterId TEXT NOT NULL,
        profileId TEXT,
        PRIMARY KEY (projectId, adapterId)
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        adapterId TEXT NOT NULL,
        configDir TEXT NOT NULL,
        accountEmail TEXT,
        accountName TEXT,
        organizationName TEXT,
        createdAt INTEGER NOT NULL
      );

      -- Node position and render state live here so a layout survives a restart.
      -- pid/status are written on exit too, because a restored node must be able to say
      -- honestly that its process did not survive.
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        profileId TEXT,
        adapterId TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        pid INTEGER,
        status TEXT NOT NULL,
        claudeSessionId TEXT,
        model TEXT,
        permissionMode TEXT,
        managed INTEGER NOT NULL DEFAULT 1,
        x REAL NOT NULL DEFAULT 0,
        y REAL NOT NULL DEFAULT 0,
        width REAL NOT NULL DEFAULT 420,
        height REAL NOT NULL DEFAULT 260,
        renderState TEXT NOT NULL DEFAULT 'preview',
        pinned INTEGER NOT NULL DEFAULT 0,
        manualPos INTEGER NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        color TEXT,
        role TEXT,
        kind TEXT NOT NULL DEFAULT 'session',
        waitingFor TEXT,
        statusSince INTEGER,
        agentId TEXT,
        parentId TEXT,
        transcriptPath TEXT,
        size TEXT NOT NULL DEFAULT 'normal',
        contextUsed REAL,
        tokensUsed INTEGER,
        contextSource TEXT,
        roleClass TEXT,
        canSpawnAgents INTEGER NOT NULL DEFAULT 1,
        canUseTeams INTEGER NOT NULL DEFAULT 1,
        effort TEXT,
        modelChoice TEXT,
        effortChoice TEXT,
        teamSize INTEGER,
        reportsTo TEXT,
        fontSize INTEGER,
        createdAt INTEGER NOT NULL,
        exitedAt INTEGER,
        exitCode INTEGER
      );

      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        relPath TEXT NOT NULL,
        title TEXT NOT NULL,
        x REAL NOT NULL DEFAULT 0,
        y REAL NOT NULL DEFAULT 0,
        width REAL NOT NULL DEFAULT 360,
        height REAL NOT NULL DEFAULT 300,
        collapsed INTEGER NOT NULL DEFAULT 0,
        manualPos INTEGER NOT NULL DEFAULT 0,
        external INTEGER NOT NULL DEFAULT 0,
        ownerId TEXT,
        web TEXT,
        kind TEXT NOT NULL DEFAULT 'text',
        size TEXT NOT NULL DEFAULT 'normal',
        fontSize INTEGER,
        webGroup TEXT,
        images TEXT,
        createdAt INTEGER NOT NULL
      );

      -- A message card: one place the owner and one card talk, kept out of the terminal and out
      -- of the mail system so a two sentence exchange is not buried under everything else the card
      -- did. The conversation itself is a file on disk; this row is only where the card sits and
      -- which session it is bound to.
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sessionId TEXT,
        path TEXT,
        x REAL NOT NULL DEFAULT 0,
        y REAL NOT NULL DEFAULT 0,
        width REAL NOT NULL DEFAULT 420,
        height REAL NOT NULL DEFAULT 420,
        fontSize INTEGER,
        createdAt INTEGER NOT NULL
      );

      -- A wire is a connection between two cards. Manual wires are drawn by the owner; derived
      -- wires are created from real events and never invented.
      CREATE TABLE IF NOT EXISTS wires (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sourceId TEXT NOT NULL,
        targetId TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'manual',
        bidirectional INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        UNIQUE(sourceId, targetId)
      );

      /*
       * A saved set of card positions for one project.
       *
       * The owner was afraid to arrange his board because a hand-built layout took real work and
       * a button press replaced it. The automatic row, named for the project itself, is written
       * before every arrangement so there is always a way back; the named ones are his own saves.
       *
       * Positions only, deliberately. A layout that also remembered which processes were running
       * would be promising something a Windows process cannot deliver, and restoring it would put
       * dead cards on the board claiming to be alive.
       */
      CREATE TABLE IF NOT EXISTS layouts (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        name TEXT NOT NULL,
        automatic INTEGER NOT NULL DEFAULT 0,
        basedOn TEXT,
        positions TEXT NOT NULL,
        savedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_layouts_project ON layouts(projectId, savedAt);

      -- How large this project's board is allowed to get.
      --
      -- A row per project rather than a constant in the source, because the owner changes it while
      -- the board is running: a quiet afternoon on one feature and a full department are different
      -- numbers, and stopping the app to edit a constant is not a thing anybody does mid-task.
      --
      -- Absent means nothing has been set and the default applies, so an existing project keeps
      -- working without a migration writing a number nobody chose.
      -- A prompt typed into one card every N minutes while the loop is on. See CardLoop in shared.
      CREATE TABLE IF NOT EXISTS loops (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        prompt TEXT NOT NULL,
        minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        lastFiredAt INTEGER,
        lastOutcome TEXT,
        runs INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS limits (
        projectId TEXT PRIMARY KEY,
        running INTEGER NOT NULL,
        cardsPerProject INTEGER NOT NULL,
        childrenPerCard INTEGER NOT NULL,
        setAt INTEGER NOT NULL
      );

      -- One row per turn: what was asked, whether the owner or another agent asked it, and what
      -- the session did about it. This is the history web's contents, and every field in it comes
      -- from a hook payload rather than from reading prose.
      CREATE TABLE IF NOT EXISTS work (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        promptId TEXT,
        origin TEXT NOT NULL,
        parentId TEXT,
        ask TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        filesTouched TEXT NOT NULL DEFAULT '[]',
        tasksCompleted TEXT NOT NULL DEFAULT '[]',
        toolCalls INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_work_session ON work(sessionId, startedAt);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        provenance TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(sessionId, ts);

      -- Claude Code deletes these off disk after 30 days. This table is the copy that outlives
      -- that rotation, so a session or subagent run is still readable long after the CLI has
      -- forgotten it. sessionId links back to a Garden card when one is known; it is nullable
      -- because most of what gets archived predates Garden ever having seen the run.
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        sessionId TEXT,
        agentId TEXT,
        sourcePath TEXT NOT NULL,
        slug TEXT NOT NULL,
        claudeSessionId TEXT,
        bytes INTEGER NOT NULL,
        lineCount INTEGER NOT NULL,
        capturedAt INTEGER NOT NULL,
        content TEXT NOT NULL,
        meta TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts(sourcePath);
      CREATE INDEX IF NOT EXISTS idx_transcripts_claude_session ON transcripts(claudeSessionId);

      -- Who is accountable for a piece of work. Canon 20.
      --
      -- A task was a string a sender chose to attach to a message, and who owned it was whatever
      -- the prose of the work order said. That is survivable when the cards are people who
      -- remember; it is the failure mode when they are sessions that do not. This is the row that
      -- makes the answer Garden's rather than the message's.
      --
      -- Keyed on (projectId, id) rather than on a generated id, because the ids already in the
      -- owner's mail history are the ids that have to keep working: T-12, play-2026-08-13,
      -- whatever the assigner chose. A surrogate key would have meant a lookup table from the only
      -- name anybody uses to the name the database prefers.
      --
      -- ownerId and assignerId are nullable for exactly one state, unbound, which is where every
      -- task from before this table starts. Nothing infers an owner from who sent the mail.
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT NOT NULL,
        projectId TEXT NOT NULL,
        ownerId TEXT,
        assignerId TEXT,
        requiredRole TEXT,
        territory TEXT NOT NULL DEFAULT '[]',
        acceptance TEXT,
        acceptanceRef TEXT,
        verifierId TEXT,
        parentId TEXT,
        state TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        closedAt INTEGER,
        PRIMARY KEY (projectId, id)
      );

      -- How a task got its current owner, append-only.
      --
      -- The task row says who holds it now. This says who held it before, who moved it, which of
      -- the closed list of reasons applied, and when. A reassignment for convenience cannot be
      -- written because there is no reason token for one, which is the owner's requirement met by
      -- what the column can hold rather than by asking nicely.
      CREATE TABLE IF NOT EXISTS task_reassignments (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        fromOwnerId TEXT,
        toOwnerId TEXT NOT NULL,
        reason TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        -- What Garden found true when it allowed the move, which is not the same as the note the
        -- dispatcher wrote. Empty unless the fact allowed on would be invisible from the row later.
        evidence TEXT NOT NULL DEFAULT '',
        byId TEXT,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reassign_task ON task_reassignments(projectId, taskId, ts);
    `)

    this.addMissingColumns()
    this.backfillUnboundTasks()
  }

  /**
   * Add columns the schema above gained after a database was first created.
   *
   * `CREATE TABLE IF NOT EXISTS` silently does nothing to a table that already exists, so every
   * column added since is absent from an existing database. That is not a theoretical problem: it
   * shipped. The `size` column was declared here, the table already existed, so every write
   * naming it failed and card resizing did nothing at all with no error anywhere.
   *
   * Adding a column is the only migration shape allowed here. Anything that drops or rewrites
   * data does not belong in a path that runs automatically on every start.
   */
  private addMissingColumns() {
    const wanted: Record<string, Record<string, string>> = {
      sessions: {
        manualPos: 'INTEGER NOT NULL DEFAULT 0',
        collapsed: 'INTEGER NOT NULL DEFAULT 0',
        color: 'TEXT',
        role: 'TEXT',
        size: "TEXT NOT NULL DEFAULT 'normal'",
        contextUsed: 'REAL',
        tokensUsed: 'INTEGER',
        contextSource: 'TEXT',
        roleClass: 'TEXT',
        canSpawnAgents: 'INTEGER NOT NULL DEFAULT 1',
        canUseTeams: 'INTEGER NOT NULL DEFAULT 1',
        /*
         * This card's own answer about subagents, and the one column on this table that must stay
         * nullable. Null is "follow the board", 0 is no, 1 is yes.
         *
         * NOT NULL DEFAULT 1 would have been the shape of every other flag here and would have been
         * wrong: every card that already exists would arrive as an explicit yes, and since a card's
         * answer beats the board's, the ceiling row would be overridden by every card on the board
         * on the day it shipped. See BoardLimits.subagentsAllowed and canon 15.
         */
        subagentsAllowed: 'INTEGER',
        effort: 'TEXT',
        modelChoice: 'TEXT',
        effortChoice: 'TEXT',
        teamSize: 'INTEGER',
        reportsTo: 'TEXT',
        fontSize: 'INTEGER',
        // Terminal or conversation. Null on every existing row, which is right: a card that has
        // never been told opens on whatever suits its kind rather than on a guess written into it.
        bodyView: 'TEXT',
        baseWidth: 'INTEGER',
        baseHeight: 'INTEGER',
        kind: "TEXT NOT NULL DEFAULT 'session'",
        waitingFor: 'TEXT',
        statusSince: 'INTEGER',
        agentId: 'TEXT',
        parentId: 'TEXT',
        transcriptPath: 'TEXT',
        // The role a running process was actually launched with, against roleClass which is only
        // the owner's current choice. Null whenever nothing is running.
        roleClassRunning: 'TEXT',
        // When the owner took this card off the board. Null while it is on it.
        closedAt: 'INTEGER',
        // JSON array of project-relative paths this card is responsible for. Null means no limit.
        ownedPaths: 'TEXT',
        /*
         * How many times this card's process has been launched, so a delayed input can be dropped
         * when it belongs to a process that has since been replaced.
         *
         * Zero on every existing row rather than one. A row that predates this column has been
         * launched an unknown number of times, and the only thing the number has to do is differ
         * from the next launch's, which it will: the next start writes 1.
         */
        generation: 'INTEGER NOT NULL DEFAULT 0',
      },
      docs: {
        external: 'INTEGER NOT NULL DEFAULT 0',
        ownerId: 'TEXT',
        web: 'TEXT',
        kind: "TEXT NOT NULL DEFAULT 'text'",
        size: "TEXT NOT NULL DEFAULT 'normal'",
        fontSize: 'INTEGER',
        webGroup: 'TEXT',
        images: 'TEXT',
      },
      projects: {
        defaultProfileId: 'TEXT',
        /* Closed tabs keep their board and leave the row; see setProjectArchived. */
        archived: 'INTEGER NOT NULL DEFAULT 0',
      },
      profiles: {
        accountEmail: 'TEXT',
        accountName: 'TEXT',
        organizationName: 'TEXT',
      },
      layouts: {
        basedOn: 'TEXT',
      },
      task_reassignments: {
        /*
         * The sentence Garden wrote when it allowed the move, on the rows where the fact it allowed
         * on cannot be seen from the row itself. Empty on every row written before this column, which
         * is honest: those hand-offs really do not say, and backfilling a sentence would invent one.
         */
        evidence: "TEXT NOT NULL DEFAULT ''",
      },
      wires: {
        label: "TEXT NOT NULL DEFAULT ''",
        kind: "TEXT NOT NULL DEFAULT 'manual'",
        bidirectional: 'INTEGER NOT NULL DEFAULT 0',
      },
      work: {
        /*
         * The tasks a turn finished, alongside the files it wrote.
         *
         * Empty on every row written before this column, and that is the honest value rather than a
         * gap: nothing recorded task transitions per turn before now, so a backfill would be
         * guessing which turn closed which task from timestamps. An older turn keeps whatever page
         * its writes earned it and gains nothing it cannot prove.
         */
        tasksCompleted: "TEXT NOT NULL DEFAULT '[]'",
      },
      loops: {
        // A board whose loops table predates the count comes back at zero rather than at null, so
        // the panel never has to decide what a missing count means.
        runs: 'INTEGER NOT NULL DEFAULT 0',
      },
      limits: {
        /*
         * How many cards may be mid-turn at once, as distinct from how many may be awake. A board
         * saved before this column existed comes back with the default rather than with nothing,
         * which matters because a missing ceiling reads as no ceiling.
         */
        working: 'INTEGER NOT NULL DEFAULT 5',
        /*
         * How hard task ownership bites on this project, and how long an owner may be quiet before
         * `owner_silent` is accepted as a reason to move the work.
         *
         * Shadow on every existing row, which is the migration canon 20 asks for in as many words:
         * nothing refuses until the owner turns it on. A board that came back from a restart
         * enforcing a ruleset nobody had watched run would refuse real mail on the first afternoon,
         * and every refusal would look like the app being broken rather than like a rule.
         */
        taskAuthority: "TEXT NOT NULL DEFAULT 'shadow'",
        silenceMinutes: 'INTEGER NOT NULL DEFAULT 60',
        // How many subagents one card may run at once. Held by the CLI, not here. See
        // BoardLimits.subagents.
        subagents: 'INTEGER NOT NULL DEFAULT 5',
        /*
         * Whether cards here may dispatch subagents at all, which is the one subagent decision
         * Garden refuses against itself. Stored as 0 or 1, since SQLite has no boolean. See
         * BoardLimits.subagentsAllowed.
         *
         * Yes on every existing row, and this is the one column on the table whose default can stop
         * work that is already happening: it is asked at the hook rather than at launch, so a
         * migration writing 0 would refuse the next dispatch on a card that is running right now,
         * for a decision nobody made.
         */
        subagentsAllowed: 'INTEGER NOT NULL DEFAULT 1',
        /*
         * What may authorize an update restart. Manual on every existing row, for the same reason
         * shadow is the authority default: a board that came back from a restart already allowed to
         * restart its own cards would have decided something the owner asked to decide.
         */
        updatePolicy: "TEXT NOT NULL DEFAULT 'manual'",
      },
    }

    for (const [table, columns] of Object.entries(wanted)) {
      let existing: string[]
      try {
        existing = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((c) => c.name)
      } catch {
        continue
      }
      if (existing.length === 0) continue
      for (const [name, decl] of Object.entries(columns)) {
        if (existing.includes(name)) continue
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`)
        console.log(`[garden] migrated: added ${table}.${name}`)
      }
    }
  }

  /**
   * Give every task id Garden has already delivered mail for a row, owned by nobody.
   *
   * Without this the Tasks panel opens empty on a board with hundreds of task ids in its history,
   * and every one of those ids is a piece of work somebody did. With it the history is visible from
   * the first start and each row says, accurately, that nobody has ever declared who owned it.
   *
   * It creates no owners, and that is the owner's own instruction rather than a simplification:
   * "Do not silently invent owners for historical work." The sender of the first message is the
   * obvious guess and it is wrong often enough to matter, because a manager relaying a work order
   * is not the card that was accountable for it. A guessed owner reads exactly like a declared one
   * and there would be no way afterwards to tell which rows were real.
   *
   * `createdAt` is the earliest delivery Garden recorded for that id, so the panel can sort by when
   * the work actually started rather than by when this migration ran.
   *
   * Idempotent by the `WHERE NOT EXISTS`: a task that has since been bound to an owner is never
   * reset to unbound by a later start, which is the one way this could do damage.
   */
  private backfillUnboundTasks() {
    const rows = this.db.prepare(`
      SELECT s.projectId AS projectId,
             json_extract(e.payload, '$.taskId') AS taskId,
             MIN(e.ts) AS firstTs
      FROM events e
      JOIN sessions s ON s.id = e.sessionId
      WHERE e.type = 'MailDelivered'
        AND json_extract(e.payload, '$.taskId') IS NOT NULL
        AND json_extract(e.payload, '$.taskId') != ''
      GROUP BY s.projectId, taskId
    `).all() as Array<{ projectId: string; taskId: string; firstTs: number }>

    const insert = this.db.prepare(`
      INSERT INTO tasks (id, projectId, ownerId, assignerId, requiredRole, territory,
                         acceptance, acceptanceRef, verifierId, parentId, state,
                         createdAt, updatedAt, closedAt)
      SELECT @taskId, @projectId, NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL, 'unbound',
             @firstTs, @firstTs, NULL
      WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE projectId = @projectId AND id = @taskId)
    `)

    let added = 0
    const run = this.db.transaction((list: typeof rows) => {
      for (const r of list) added += insert.run(r).changes
    })
    run(rows)
    if (added > 0) {
      console.log(
        `[garden] migrated: ${added} task id${added === 1 ? '' : 's'} from mail history recorded as unbound, ` +
        'owned by nobody until somebody binds them',
      )
    }
  }

  // --- projects ---

  /**
   * The tabs on the row. A closed one is not gone, it is parked.
   *
   * The owner's words: closing a tab should stop its sessions and take it off the row, and keep its
   * layout so he can open it again later. So the board stays exactly as it was, cards, wires,
   * positions and all, and only the tab goes.
   */
  listProjects(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects WHERE COALESCE(archived, 0) = 0 ORDER BY lastOpenedAt DESC')
      .all() as any[]
    return rows.map((r) => this.hydrateProject(r))
  }

  /** The tabs he has closed, newest first, so one can be picked back up by name. */
  listClosedProjects(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects WHERE COALESCE(archived, 0) = 1 ORDER BY lastOpenedAt DESC')
      .all() as any[]
    return rows.map((r) => this.hydrateProject(r))
  }

  setProjectArchived(id: string, archived: boolean) {
    this.db
      .prepare('UPDATE projects SET archived = ?, lastOpenedAt = ? WHERE id = ?')
      .run(archived ? 1 : 0, Date.now(), id)
  }

  private hydrateProject(row: any): Project {
    const map = this.db.prepare('SELECT adapterId, profileId FROM project_profiles WHERE projectId = ?')
      .all(row.id) as Array<{ adapterId: string; profileId: string | null }>
    const profiles: Record<string, string | null> = {}
    for (const m of map) profiles[m.adapterId] = m.profileId
    // The old single-slot column is the Claude slot, so a database written before this still works.
    if (profiles.claude === undefined && row.defaultProfileId) profiles.claude = row.defaultProfileId
    return { ...row, profiles }
  }

  getProjectByPath(path: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as any
    return row ? this.hydrateProject(row) : undefined
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any
    return row ? this.hydrateProject(row) : undefined
  }

  insertProject(p: Project) {
    this.db.prepare(`
      INSERT INTO projects (id,name,path,color,defaultAdapterId,defaultProfileId,notes,createdAt,lastOpenedAt)
      VALUES (@id,@name,@path,@color,@defaultAdapterId,@defaultProfileId,@notes,@createdAt,@lastOpenedAt)
    `).run({ ...p, profiles: undefined })
  }

  touchProject(id: string) {
    this.db.prepare('UPDATE projects SET lastOpenedAt = ? WHERE id = ?').run(Date.now(), id)
  }

  deleteProfile(id: string) {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id)
    this.db.prepare('UPDATE projects SET defaultProfileId = NULL WHERE defaultProfileId = ?').run(id)
    this.db.prepare('UPDATE project_profiles SET profileId = NULL WHERE profileId = ?').run(id)
  }

  setProjectProfile(projectId: string, adapterId: string, profileId: string | null) {
    this.db.prepare(`
      INSERT INTO project_profiles (projectId, adapterId, profileId) VALUES (?, ?, ?)
      ON CONFLICT(projectId, adapterId) DO UPDATE SET profileId = excluded.profileId
    `).run(projectId, adapterId, profileId)
    if (adapterId === 'claude') {
      this.db.prepare('UPDATE projects SET defaultProfileId = ? WHERE id = ?').run(profileId, projectId)
    }
  }

  getProjectProfile(projectId: string, adapterId: string): string | null {
    const row = this.db.prepare('SELECT profileId FROM project_profiles WHERE projectId = ? AND adapterId = ?')
      .get(projectId, adapterId) as { profileId: string | null } | undefined
    return row?.profileId ?? null
  }

  /**
   * Remove a project and everything that only existed because of it.
   *
   * Everything, because a board is not just its sessions: the file cards hanging off them, the
   * wires between them and the layouts saved for that board all carry the project's id and all of
   * them used to survive it. A database that had seen a few scratch projects come and go kept
   * every card and wire any of them ever had, invisible and permanent.
   *
   * Deliberately not touched: the notes and history directories under the workspace, and the files
   * on disk a card pointed at. Those are the owner's, and no button in this app should be able to
   * delete his work.
   */
  deleteProject(id: string) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE projectId = ?').run(id)
    this.db.prepare('DELETE FROM docs WHERE projectId = ?').run(id)
    this.db.prepare('DELETE FROM wires WHERE projectId = ?').run(id)
    this.db.prepare('DELETE FROM layouts WHERE projectId = ?').run(id)
    // The account binding outlived the project it belonged to, so a database that had seen a few
    // scratch projects come and go accumulated rows for projects that no longer exist.
    this.db.prepare('DELETE FROM project_profiles WHERE projectId = ?').run(id)
  }

  /** Bindings whose project is gone, left behind before deleteProject cleaned up after itself. */
  pruneOrphanedBindings(): number {
    const res = this.db.prepare(
      'DELETE FROM project_profiles WHERE projectId NOT IN (SELECT id FROM projects)',
    ).run()
    return res.changes
  }

  /**
   * Cards and wires whose owner no longer exists.
   *
   * A doc card hangs off a session card, and a web card is only ever reachable through the card it
   * belongs to: its menu, its fold control and its frame all come from the owner. Delete the owner
   * and the children stay in the database and stay drawn, with nothing left that can address them.
   * The owner found 60 of them on his board, three whole context webs belonging to sessions that
   * were gone, and no way to remove a single one.
   *
   * They are removed rather than reattached because there is nothing honest to reattach them to. A
   * web says "this is what that card works from", and that card does not exist.
   *
   * Only genuine orphans: a card with no `ownerId` was opened by hand and belongs to the board
   * itself, so it is left exactly where it is.
   */
  pruneOrphanedCards(): { docs: number; wires: number } {
    const docs = this.db.prepare(
      'DELETE FROM docs WHERE ownerId IS NOT NULL AND ownerId NOT IN (SELECT id FROM sessions)',
    ).run().changes
    /*
     * Then the wires, including any that the sweep above just stranded. A wire can join two session
     * cards or a card to one of its documents, so both ends are checked against both tables.
     */
    const wires = this.db.prepare(`
      DELETE FROM wires WHERE
        sourceId NOT IN (SELECT id FROM sessions UNION SELECT id FROM docs)
        OR targetId NOT IN (SELECT id FROM sessions UNION SELECT id FROM docs)
    `).run().changes
    return { docs, wires }
  }

  // --- profiles ---

  listProfiles(): Profile[] {
    return this.db.prepare('SELECT * FROM profiles ORDER BY createdAt').all() as Profile[]
  }

  getProfile(id: string): Profile | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile | undefined
  }

  upsertProfile(p: Profile) {
    this.db.prepare(`
      INSERT INTO profiles (id,name,adapterId,configDir,accountEmail,accountName,organizationName,createdAt)
      VALUES (@id,@name,@adapterId,@configDir,@accountEmail,@accountName,@organizationName,@createdAt)
      ON CONFLICT(id) DO UPDATE SET
        name=@name, accountEmail=@accountEmail, accountName=@accountName,
        organizationName=@organizationName
    `).run(p)
  }

  // --- sessions ---

  listSessions(): TerminalSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY createdAt').all() as any[]
    return rows.map(hydrateSession)
  }

  getSession(id: string): TerminalSession | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
    return row ? hydrateSession(row) : undefined
  }

  upsertSession(s: TerminalSession) {
    this.db.prepare(`
      INSERT INTO sessions (id,projectId,profileId,adapterId,kind,title,cwd,pid,status,waitingFor,
        statusSince,agentId,parentId,transcriptPath,claudeSessionId,
        model,permissionMode,managed,x,y,width,height,renderState,pinned,manualPos,collapsed,color,role,size,contextUsed,tokensUsed,contextSource,roleClass,roleClassRunning,closedAt,ownedPaths,generation,canSpawnAgents,canUseTeams,subagentsAllowed,effort,modelChoice,effortChoice,teamSize,reportsTo,fontSize,bodyView,baseWidth,baseHeight,createdAt,exitedAt,exitCode)
      VALUES (@id,@projectId,@profileId,@adapterId,@kind,@title,@cwd,@pid,@status,@waitingFor,
        @statusSince,@agentId,@parentId,@transcriptPath,@claudeSessionId,
        @model,@permissionMode,@managed,@x,@y,@width,@height,@renderState,@pinned,@manualPos,@collapsed,@color,@role,@size,@contextUsed,@tokensUsed,@contextSource,@roleClass,@roleClassRunning,@closedAt,@ownedPaths,@generation,@canSpawnAgents,@canUseTeams,@subagentsAllowed,@effort,@modelChoice,@effortChoice,@teamSize,@reportsTo,@fontSize,@bodyView,@baseWidth,@baseHeight,@createdAt,@exitedAt,@exitCode)
      ON CONFLICT(id) DO UPDATE SET
        title=@title, cwd=@cwd, pid=@pid, status=@status, claudeSessionId=@claudeSessionId,
        waitingFor=@waitingFor, statusSince=@statusSince, agentId=@agentId, parentId=@parentId,
        transcriptPath=@transcriptPath, kind=@kind,
        model=@model, permissionMode=@permissionMode, x=@x, y=@y, width=@width, height=@height,
        renderState=@renderState, pinned=@pinned, manualPos=@manualPos, collapsed=@collapsed,
        color=@color, role=@role, size=@size, contextUsed=@contextUsed, tokensUsed=@tokensUsed,
        contextSource=@contextSource, roleClass=@roleClass, roleClassRunning=@roleClassRunning,
        closedAt=@closedAt, ownedPaths=@ownedPaths, generation=@generation,
        canSpawnAgents=@canSpawnAgents,
        canUseTeams=@canUseTeams, subagentsAllowed=@subagentsAllowed,
        effort=@effort, modelChoice=@modelChoice,
        effortChoice=@effortChoice, teamSize=@teamSize, reportsTo=@reportsTo,
        baseWidth=@baseWidth, baseHeight=@baseHeight,
        fontSize=@fontSize, bodyView=@bodyView,
        exitedAt=@exitedAt, exitCode=@exitCode
    `).run({
      ...s,
      // Stored as JSON text, because SQLite has no array and a card's owned paths are read back as
      // a whole list or not at all. Null stays null so "no limit" and "an empty list" stay distinct.
      ownedPaths: s.ownedPaths ? JSON.stringify(s.ownedPaths) : null,
      // A row constructed before this field existed, or by a caller that spread an older object,
      // stores 0 rather than null: the column is NOT NULL and a generation of null would compare
      // equal to nothing, which would drop every delayed input instead of only the stale ones.
      generation: Number.isInteger(s.generation) ? s.generation : 0,
      managed: s.managed ? 1 : 0,
      canSpawnAgents: s.canSpawnAgents ? 1 : 0,
      canUseTeams: s.canUseTeams ? 1 : 0,
      // Three states rather than two, so `null` has to survive the trip rather than being flattened
      // into a 0 by the `? 1 : 0` the flags above use. A card with no answer of its own follows the
      // board, and that is a different thing from a card that said no.
      subagentsAllowed: s.subagentsAllowed == null ? null : s.subagentsAllowed ? 1 : 0,
      pinned: s.pinned ? 1 : 0,
      manualPos: s.manualPos ? 1 : 0,
      collapsed: s.collapsed ? 1 : 0,
    })
  }

  /** The card a CLI session id belongs to. Set from the first hook event, never guessed. */
  findSessionByClaudeId(claudeSessionId: string): TerminalSession | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE claudeSessionId = ? ORDER BY createdAt DESC')
      .get(claudeSessionId) as any
    return row ? hydrateSession(row) : undefined
  }

  /** The card standing for one spawned agent, so a stop event finds the card its start created. */
  findSessionByAgentId(agentId: string): TerminalSession | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE agentId = ?').get(agentId) as any
    return row ? hydrateSession(row) : undefined
  }

  // --- loops ---

  listLoops(projectId?: string): CardLoop[] {
    const rows = (projectId
      ? this.db.prepare('SELECT * FROM loops WHERE projectId = ? ORDER BY createdAt').all(projectId)
      : this.db.prepare('SELECT * FROM loops ORDER BY createdAt').all()) as any[]
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      sessionId: r.sessionId,
      prompt: r.prompt,
      minutes: r.minutes,
      enabled: !!r.enabled,
      lastFiredAt: r.lastFiredAt ?? null,
      lastOutcome: r.lastOutcome ?? null,
      runs: r.runs ?? 0,
      createdAt: r.createdAt,
    }))
  }

  getLoop(id: string): CardLoop | undefined {
    return this.listLoops().find((l) => l.id === id)
  }

  setLoop(loop: CardLoop) {
    this.db.prepare(`
      INSERT INTO loops (id, projectId, sessionId, prompt, minutes, enabled, lastFiredAt, lastOutcome, runs, createdAt)
      VALUES (@id, @projectId, @sessionId, @prompt, @minutes, @enabled, @lastFiredAt, @lastOutcome, @runs, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        sessionId=@sessionId, prompt=@prompt, minutes=@minutes, enabled=@enabled,
        lastFiredAt=@lastFiredAt, lastOutcome=@lastOutcome
    `).run({ ...loop, enabled: loop.enabled ? 1 : 0, runs: loop.runs ?? 0 })
  }

  /*
   * The run count moves with `lastFiredAt` and never on its own, because they record the same event:
   * the prompt actually going into the card. A loop held because its card was working records the
   * reason and nothing else, so the count stays a count of prompts typed rather than of times the
   * clock came round. `setLoop` above deliberately does not carry it into the UPDATE, so editing a
   * loop's prompt or interval cannot reset the history of it.
   */
  markLoop(id: string, lastFiredAt: number | null, lastOutcome: string) {
    if (lastFiredAt === null) {
      this.db.prepare('UPDATE loops SET lastOutcome = ? WHERE id = ?').run(lastOutcome, id)
    } else {
      this.db.prepare('UPDATE loops SET lastFiredAt = ?, lastOutcome = ?, runs = runs + 1 WHERE id = ?')
        .run(lastFiredAt, lastOutcome, id)
    }
  }

  deleteLoop(id: string) {
    this.db.prepare('DELETE FROM loops WHERE id = ?').run(id)
  }

  // --- limits ---

  getLimits(projectId: string): BoardLimits {
    const row = this.db.prepare('SELECT * FROM limits WHERE projectId = ?').get(projectId) as any
    if (!row) return { ...DEFAULT_LIMITS }
    return {
      running: row.running,
      cardsPerProject: row.cardsPerProject,
      childrenPerCard: row.childrenPerCard,
      /*
       * A row written before the column existed reads null through the migration's default only
       * for rows added afterwards, so fall back here as well rather than handing out a ceiling of
       * null. A missing number reads as no ceiling everywhere downstream, which is the wrong
       * direction to fail in for a guardrail.
       */
      working: row.working ?? DEFAULT_LIMITS.working,
      /*
       * Same fallback and the same reason, in the one direction that is safe for this field. A row
       * written before the column existed reads null, and null must become `shadow` rather than
       * `enforce`: a missing setting turning into the strictest one would refuse mail on a board
       * whose owner never asked for it.
       */
      taskAuthority: row.taskAuthority ?? DEFAULT_LIMITS.taskAuthority,
      silenceMinutes: row.silenceMinutes ?? DEFAULT_LIMITS.silenceMinutes,
      subagents: row.subagents ?? DEFAULT_LIMITS.subagents,
      /*
       * Stored as 0 or 1 and read back as a boolean, so everything above this line in the codebase
       * deals in yes and no rather than in a number that happens to be one.
       *
       * Null for a row written before the column existed, and null must read as yes: a missing
       * answer turning into a refusal would stop dispatches on a board whose owner never said no.
       */
      subagentsAllowed: row.subagentsAllowed == null
        ? DEFAULT_LIMITS.subagentsAllowed
        : !!row.subagentsAllowed,
      // Manual for a row that predates the column, the same direction of safety: a missing policy
      // must never read as permission to restart a card nobody asked to restart.
      updatePolicy: row.updatePolicy ?? DEFAULT_LIMITS.updatePolicy,
    }
  }

  setLimits(projectId: string, limits: BoardLimits) {
    this.db.prepare(`
      INSERT INTO limits (projectId, running, cardsPerProject, childrenPerCard, working,
                          taskAuthority, silenceMinutes, subagents, subagentsAllowed, updatePolicy,
                          setAt)
      VALUES (@projectId, @running, @cardsPerProject, @childrenPerCard, @working,
              @taskAuthority, @silenceMinutes, @subagents, @subagentsAllowed, @updatePolicy, @setAt)
      ON CONFLICT(projectId) DO UPDATE SET
        running=@running, cardsPerProject=@cardsPerProject,
        childrenPerCard=@childrenPerCard, working=@working,
        taskAuthority=@taskAuthority, silenceMinutes=@silenceMinutes,
        subagents=@subagents, subagentsAllowed=@subagentsAllowed,
        updatePolicy=@updatePolicy, setAt=@setAt
    `).run({
      projectId,
      ...limits,
      // better-sqlite3 refuses a JavaScript boolean as a parameter, so the yes or no becomes the 0
      // or 1 the column holds here, at the single point where this field meets the database.
      //
      // This comment was inside the template string above for one run, which made it SQL rather
      // than a note and turned every ceiling change into `near "/": syntax error`. Nothing on
      // screen said so: the panel sent, the server refused, and the row read back unchanged.
      subagentsAllowed: limits.subagentsAllowed ? 1 : 0,
      setAt: Date.now(),
    })
  }

  // --- tasks ---

  getTask(projectId: string, id: string): TaskContract | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE projectId = ? AND id = ?')
      .get(projectId, id) as any
    return row ? hydrateTask(row) : undefined
  }

  listTasks(projectId: string): TaskContract[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE projectId = ? ORDER BY createdAt DESC')
      .all(projectId) as any[]
    return rows.map(hydrateTask)
  }

  /** Every task on every board, for the full `state` message the page gets at load. */
  listAllTasks(): TaskContract[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC').all() as any[]
    return rows.map(hydrateTask)
  }

  /**
   * Write a task, whole.
   *
   * Whole rather than field by field on purpose. Every caller reads the row, applies one rule from
   * `tasks.ts`, and writes the result back, so a partial update helper would be a second way to
   * change a task that skipped the rule. `updatedAt` is stamped here rather than trusted from the
   * caller.
   */
  upsertTask(task: TaskContract) {
    this.db.prepare(`
      INSERT INTO tasks (id, projectId, ownerId, assignerId, requiredRole, territory,
                         acceptance, acceptanceRef, verifierId, parentId, state,
                         createdAt, updatedAt, closedAt)
      VALUES (@id, @projectId, @ownerId, @assignerId, @requiredRole, @territory,
              @acceptance, @acceptanceRef, @verifierId, @parentId, @state,
              @createdAt, @updatedAt, @closedAt)
      ON CONFLICT(projectId, id) DO UPDATE SET
        ownerId=@ownerId, assignerId=@assignerId, requiredRole=@requiredRole,
        territory=@territory, acceptance=@acceptance, acceptanceRef=@acceptanceRef,
        verifierId=@verifierId, parentId=@parentId, state=@state,
        updatedAt=@updatedAt, closedAt=@closedAt
    `).run({
      ...task,
      territory: JSON.stringify(task.territory ?? []),
      acceptanceRef: task.acceptanceRef ? JSON.stringify(task.acceptanceRef) : null,
      updatedAt: Date.now(),
    })
  }

  listReassignments(projectId: string): TaskReassignment[] {
    const rows = this.db.prepare('SELECT * FROM task_reassignments WHERE projectId = ? ORDER BY ts')
      .all(projectId) as any[]
    return rows.map(hydrateReassignment)
  }

  listAllReassignments(): TaskReassignment[] {
    const rows = this.db.prepare('SELECT * FROM task_reassignments ORDER BY ts').all() as any[]
    return rows.map(hydrateReassignment)
  }

  insertReassignment(row: TaskReassignment) {
    this.db.prepare(`
      INSERT INTO task_reassignments (id, taskId, projectId, fromOwnerId, toOwnerId, reason, note, evidence, byId, ts)
      VALUES (@id, @taskId, @projectId, @fromOwnerId, @toOwnerId, @reason, @note, @evidence, @byId, @ts)
    `).run({ ...row, evidence: row.evidence ?? '' })
  }

  /**
   * What this card is holding right now, which is what the territory check reads on every write.
   *
   * `working` and `remediating` only. A task in `in_review` is with its verifier and the owner is
   * not expected to be writing against it, and `done` is finished; counting either would keep a
   * card's territory open long after the work stopped.
   */
  activeTasksFor(cardId: string): TaskContract[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE ownerId = ? AND closedAt IS NULL AND state IN ('working','remediating')
      ORDER BY updatedAt DESC
    `).all(cardId) as any[]
    return rows.map(hydrateTask)
  }

  /**
   * The last time this card was observed doing anything, from Garden's own records.
   *
   * The newest of a turn starting and an event arriving, because neither alone is the answer: a
   * card mid-way through one long turn has an old `work.startedAt` and a stream of recent events,
   * and a card that was just given work has a fresh turn and may not have emitted an event yet.
   *
   * This is the only evidence behind the `owner_silent` reassignment reason, so it has to be a
   * measurement rather than an impression. Zero means Garden has never seen this card do anything,
   * which is deliberately not the same as "silent for a long time": a card that has never run has
   * nothing to be silent about, and the caller decides what to make of that.
   */
  lastActivityFor(cardId: string): number {
    const w = this.db.prepare('SELECT MAX(startedAt) AS t FROM work WHERE sessionId = ?')
      .get(cardId) as any
    const e = this.db.prepare('SELECT MAX(ts) AS t FROM events WHERE sessionId = ?')
      .get(cardId) as any
    return Math.max(w?.t ?? 0, e?.t ?? 0)
  }

  /**
   * What ownership refused, or would have refused, on this project's cards.
   *
   * Read back from the events table rather than only broadcast, because the page throws away every
   * `event` message it receives and a refusal that lives only in a broadcast is gone on reload. In
   * shadow mode the entire value of the feature is a list the owner can sit and read before he
   * turns enforcement on, so that list has to survive a refresh.
   *
   * Newest first and capped: this grows for as long as shadow mode is on.
   */
  listTaskRefusals(projectId: string, limit = 200): AgentEvent[] {
    /*
     * A LEFT JOIN and the board row, rather than an inner join on the sender's card.
     *
     * One kind of refusal belongs to no card: a socket that says hello with no key and no token has
     * no identity to file an event against, so `index.ts` files it under the board. An inner join
     * dropped exactly those rows, which is the half of the record canon 20 revision 2 asks for. The
     * board's rows come back for every project, because a socket is board-wide.
     */
    const rows = this.db.prepare(`
      SELECT e.* FROM events e
      LEFT JOIN sessions s ON s.id = e.sessionId
      WHERE (s.projectId = ? OR e.sessionId = 'board')
        AND e.type IN ('TaskRefused','TaskWouldRefuse','SenderUnverified')
      ORDER BY e.ts DESC
      LIMIT ?
    `).all(projectId, limit) as any[]
    return rows.map(hydrateEvent)
  }

  /**
   * The cards that count against the ceiling: everything on this project's board that has not been
   * closed and is actually drawn on it. Teammate cards included, subagent cards not.
   *
   * Subagents used to be counted here on purpose, because a dispatch was the path that produced the
   * runaway. That stopped being true when the canvas stopped drawing them: the owner was refused a
   * card because the board "holds 22" against a ceiling of 12 while he could see three, and 19 of
   * the 22 were spent subagents from work that had already finished. A guardrail that refuses with a
   * figure he cannot check anywhere is worse than no figure, so this counts what he can see and
   * `countSubagents` reports the rest beside it.
   *
   * What that costs, since it is a real hole rather than a tidy-up: nothing bounds concurrent
   * subagent work by count any more. The answer to it is the working ceiling, which is what actually
   * spends a context window, and that number is persisted but not yet enforced.
   *
   * A teammate is still counted. It is a peer session with a context window of its own, the canvas
   * draws it, and the owner can talk to it, so it is a card by every test that matters here.
   */
  countCards(projectId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE projectId = ? AND closedAt IS NULL AND kind != 'subagent'",
    ).get(projectId) as any
    return row?.n ?? 0
  }

  /**
   * The spawned agents on this board, counted on their own and limited by nothing.
   *
   * Shown beside the ceiling rather than against it: the owner's reading is that these are
   * background tools a session reaches for rather than agent work holding a window open, and a
   * figure with no X-of-Y beside it is how the panel says a number is watched and not capped.
   */
  countSubagents(projectId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE projectId = ? AND closedAt IS NULL AND kind = 'subagent'",
    ).get(projectId) as any
    return row?.n ?? 0
  }

  /**
   * The ones with something running behind them right now, board-wide.
   *
   * Subagents are excluded for the same reason they are excluded from `countCards`, and it matters
   * more here: a spawned agent card is created with status `working` and a null pid, and it keeps
   * that status after its agent has finished. So a day's dispatches sat in this count forever and
   * refused the owner a card he had room for, on the strength of processes that had never existed.
   * A card with nothing behind it is not running, and a refusal built on one was never true.
   *
   * The statuses come from `RUNNING_STATUSES` in the shared package rather than being spelled here,
   * because the header at the top of the window answers the same question and used to answer it
   * differently. One list, read by both.
   */
  countRunning(projectId: string): number {
    const holes = RUNNING_STATUSES.map(() => '?').join(',')
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM sessions
      WHERE projectId = ? AND closedAt IS NULL AND kind != 'subagent'
        AND status IN (${holes})
    `).get(projectId, ...RUNNING_STATUSES) as any
    return row?.n ?? 0
  }

  childSessions(parentId: string): TerminalSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE parentId = ? ORDER BY createdAt').all(parentId) as any[]
    return rows.map(hydrateSession)
  }

  deleteSession(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  /**
   * Nothing survives an app restart: a Windows process cannot be re-parented into a new
   * instance. Mark every previously-live session stopped so a restored card reports the truth
   * rather than showing a stale "working" badge. The card itself is never removed.
   *
   * Returns the ids it just stopped, which is the list of cards that were working a moment ago.
   * The caller starts them again. That is not the same claim as the paragraph above and must not
   * be confused with it: the old process is gone and is not coming back, and what comes up is a
   * new one resuming the same conversation through `--resume`. Garden may say it brought the card
   * back; it may never say the session survived.
   *
   * Returned rather than queried afterwards, because the UPDATE below is what destroys the
   * evidence. A second query would find every row already stopped and could not tell a card the
   * owner had switched off an hour ago from one that was mid-turn when the backend went down.
   */
  /**
   * Mark everything stopped, and hand back what was live AND what it was doing.
   *
   * The status was already read by this query and then thrown away, so the caller could only ask
   * "was it live", and for a mature board the answer was "all of them". Returning it lets the caller
   * decide, which is the whole of the fix for a restart costing more every time a card is added.
   */
  markAllExitedOnBoot(): Array<{ id: string; status: string }> {
    const wereLive = (
      this.db.prepare(`
        SELECT id, status FROM sessions
        WHERE closedAt IS NULL AND kind = 'session' AND status NOT IN ('stopped','failed','done')
      `).all() as Array<{ id: string; status: string }>
    ).map((r) => ({ id: r.id, status: r.status }))
    this.db.prepare(`
      UPDATE sessions SET status = 'stopped', pid = NULL, exitedAt = COALESCE(exitedAt, ?)
      WHERE status NOT IN ('stopped','failed','done')
    `).run(Date.now())
    /*
     * And no card is running a role, because no card is running.
     *
     * The exit handler clears this, but on a clean shutdown the kill usually loses the race with
     * the process ending, so rows come back carrying the role their last process was launched with.
     * A stopped card would then show its old role as the one in effect, and changing that card's
     * role would draw "worker pending" against a manager that has not existed since the restart.
     * The column's whole contract is that it is null when nothing is running, and after a boot
     * nothing is.
     */
    this.db.prepare('UPDATE sessions SET roleClassRunning = NULL WHERE roleClassRunning IS NOT NULL').run()
    return wereLive
  }

  // --- message cards ---

  listChannels(): Channel[] {
    return this.db.prepare('SELECT * FROM channels ORDER BY createdAt').all().map(hydrateChannel)
  }

  getChannel(id: string): Channel | undefined {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as any
    return row ? hydrateChannel(row) : undefined
  }

  /** The channel bound to a card, if it has one. A card has at most one, which is the point of it. */
  channelForSession(sessionId: string): Channel | undefined {
    const row = this.db.prepare('SELECT * FROM channels WHERE sessionId = ?').get(sessionId) as any
    return row ? hydrateChannel(row) : undefined
  }

  upsertChannel(c: Channel) {
    this.db.prepare(`
      INSERT INTO channels (id,projectId,sessionId,path,x,y,width,height,fontSize,createdAt)
      VALUES (@id,@projectId,@sessionId,@path,@x,@y,@width,@height,@fontSize,@createdAt)
      ON CONFLICT(id) DO UPDATE SET
        sessionId=@sessionId, path=@path, x=@x, y=@y, width=@width, height=@height, fontSize=@fontSize
    `).run(c)
  }

  deleteChannel(id: string) {
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(id)
  }

  // --- doc cards ---

  listDocs(): DocCard[] {
    const rows = this.db.prepare('SELECT * FROM docs ORDER BY createdAt').all() as any[]
    return rows.map(hydrateDoc)
  }

  getDoc(id: string): DocCard | undefined {
    const row = this.db.prepare('SELECT * FROM docs WHERE id = ?').get(id) as any
    return row ? hydrateDoc(row) : undefined
  }

  findDoc(projectId: string, relPath: string): DocCard | undefined {
    const row = this.db.prepare('SELECT * FROM docs WHERE projectId = ? AND relPath = ?')
      .get(projectId, relPath) as any
    return row ? hydrateDoc(row) : undefined
  }

  /**
   * Every card in this project for one file, because there is legitimately more than one.
   *
   * Two sessions in the same project usually run from some of the same files: the project's own
   * CLAUDE.md is in every card's roots, and so is anything in the user's settings. Keying a card by
   * path alone made that one card that could only belong to whoever opened it last, so opening one
   * session's roots reached into another session's block and took cards out of it. The owner's rule
   * is that each card has its own roots to pull from, so the caller picks the one that is its own.
   */
  findDocsByPath(projectId: string, relPath: string): DocCard[] {
    const rows = this.db.prepare('SELECT * FROM docs WHERE projectId = ? AND relPath = ?')
      .all(projectId, relPath) as any[]
    return rows.map(hydrateDoc)
  }

  upsertDoc(d: DocCard) {
    this.db.prepare(`
      INSERT INTO docs (id,projectId,relPath,title,x,y,width,height,collapsed,manualPos,
        external,ownerId,web,kind,size,fontSize,webGroup,images,createdAt)
      VALUES (@id,@projectId,@relPath,@title,@x,@y,@width,@height,@collapsed,@manualPos,
        @external,@ownerId,@web,@kind,@size,@fontSize,@webGroup,@images,@createdAt)
      ON CONFLICT(id) DO UPDATE SET
        title=@title, x=@x, y=@y, width=@width, height=@height,
        collapsed=@collapsed, manualPos=@manualPos, ownerId=@ownerId, web=@web, size=@size,
        fontSize=@fontSize, images=@images
    `).run({
      ...d,
      collapsed: d.collapsed ? 1 : 0,
      manualPos: d.manualPos ? 1 : 0,
      external: d.external ? 1 : 0,
      // `group` is a SQL reserved word, so the column is webGroup. Using the bare name made the
      // migration re-add it on every start and take the whole server down with it.
      webGroup: d.group ?? null,
      images: JSON.stringify(d.images ?? []),
    })
  }

  /** Cards belonging to one card's web, so folding it away removes exactly those. */
  listWebDocs(ownerId: string, web: string): DocCard[] {
    const rows = this.db.prepare('SELECT * FROM docs WHERE ownerId = ? AND web = ?')
      .all(ownerId, web) as any[]
    return rows.map(hydrateDoc)
  }

  /** Hands layout back to the packer for one project, for both card kinds. */
  clearManualPositions(projectId: string) {
    this.db.prepare('UPDATE sessions SET manualPos = 0 WHERE projectId = ?').run(projectId)
    this.db.prepare('UPDATE docs SET manualPos = 0 WHERE projectId = ?').run(projectId)
  }

  deleteDoc(id: string) {
    this.db.prepare('DELETE FROM docs WHERE id = ?').run(id)
  }

  // --- wires ---

  listWires(): Wire[] {
    return (this.db.prepare('SELECT * FROM wires ORDER BY createdAt').all() as any[]).map(hydrateWire)
  }

  getWire(id: string): Wire | undefined {
    const row = this.db.prepare('SELECT * FROM wires WHERE id = ?').get(id) as any
    return row ? hydrateWire(row) : undefined
  }

  findWire(sourceId: string, targetId: string): Wire | undefined {
    const row = this.db.prepare('SELECT * FROM wires WHERE sourceId = ? AND targetId = ?')
      .get(sourceId, targetId) as any
    return row ? hydrateWire(row) : undefined
  }

  upsertWire(w: Wire) {
    this.db.prepare(`
      INSERT INTO wires (id,projectId,sourceId,targetId,label,kind,bidirectional,createdAt)
      VALUES (@id,@projectId,@sourceId,@targetId,@label,@kind,@bidirectional,@createdAt)
      ON CONFLICT(id) DO UPDATE SET label=@label, kind=@kind, bidirectional=@bidirectional
    `).run({ ...w, bidirectional: w.bidirectional ? 1 : 0 })
  }

  deleteWire(id: string) {
    this.db.prepare('DELETE FROM wires WHERE id = ?').run(id)
  }

  /** Wires die with the cards they connect, since a wire to nothing is meaningless. */
  deleteWiresForCard(cardId: string): string[] {
    const rows = this.db.prepare('SELECT id FROM wires WHERE sourceId = ? OR targetId = ?')
      .all(cardId, cardId) as Array<{ id: string }>
    this.db.prepare('DELETE FROM wires WHERE sourceId = ? OR targetId = ?').run(cardId, cardId)
    return rows.map((r) => r.id)
  }

  // --- work records ---

  listWork(sessionId: string): WorkRecord[] {
    const rows = this.db.prepare('SELECT * FROM work WHERE sessionId = ? ORDER BY startedAt DESC LIMIT 200')
      .all(sessionId) as any[]
    return rows.map(hydrateWork)
  }

  getWork(id: string): WorkRecord | undefined {
    const row = this.db.prepare('SELECT * FROM work WHERE id = ?').get(id) as any
    return row ? hydrateWork(row) : undefined
  }

  /** The turn a hook event belongs to, matched on the CLI's own prompt_id. */
  findOpenWork(sessionId: string, promptId: string | null): WorkRecord | undefined {
    const row = promptId
      ? this.db.prepare('SELECT * FROM work WHERE sessionId = ? AND promptId = ?').get(sessionId, promptId)
      : this.db.prepare('SELECT * FROM work WHERE sessionId = ? AND endedAt IS NULL ORDER BY startedAt DESC')
          .get(sessionId)
    return row ? hydrateWork(row as any) : undefined
  }

  upsertWork(w: WorkRecord) {
    this.db.prepare(`
      INSERT INTO work (id,sessionId,promptId,origin,parentId,ask,startedAt,endedAt,filesTouched,
                        tasksCompleted,toolCalls)
      VALUES (@id,@sessionId,@promptId,@origin,@parentId,@ask,@startedAt,@endedAt,@filesTouched,
              @tasksCompleted,@toolCalls)
      ON CONFLICT(id) DO UPDATE SET
        ask=@ask, endedAt=@endedAt, filesTouched=@filesTouched,
        tasksCompleted=@tasksCompleted, toolCalls=@toolCalls
    `).run({
      ...w,
      filesTouched: JSON.stringify(w.filesTouched),
      tasksCompleted: JSON.stringify(w.tasksCompleted ?? []),
    })
  }

  deleteWorkForSession(sessionId: string) {
    this.db.prepare('DELETE FROM work WHERE sessionId = ?').run(sessionId)
    this.db.prepare('DELETE FROM events WHERE sessionId = ?').run(sessionId)
  }

  /**
   * The newest events a session has produced, oldest first.
   *
   * The pipeline reads these to decide what a run actually did, so it needs the turn in order
   * rather than a tail. Capped because a long session can hold tens of thousands and no consumer
   * needs all of them at once. The cap keeps the NEWEST rows: until 2026-09-05 it kept the oldest,
   * and on a card with more history than the cap every caller was reading August and nothing
   * since. The launch watchdog was one of them, so it never saw a fresh SessionStart on those
   * cards and ended fifteen of the owner's CLIs sixty seconds after every launch.
   */
  listEvents(sessionId: string, limit = 4000): AgentEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE sessionId = ? ORDER BY ts DESC LIMIT ?')
      .all(sessionId, limit) as any[]
    return rows.reverse().map(hydrateEvent)
  }

  /**
   * Every delivery a session has recorded, oldest first, with no cap.
   *
   * The mail hops behind a task are read from these, and a card's deliveries are a small fraction
   * of its events, so under any paged read they scroll off while the task is still open and the
   * spiral guard's answer starts depending on tool traffic rather than on how many times the work
   * went round. Asked for by type so the cap on `listEvents` never applies.
   */
  listMailDelivered(sessionId: string): AgentEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE sessionId = ? AND type = 'MailDelivered' ORDER BY ts")
      .all(sessionId) as any[]
    return rows.map(hydrateEvent)
  }

  /**
   * Whether any event at or after `ts` exists, for one session or, with null, for every session but
   * `except`. One indexed row rather than a page of them, because the launch watchdog asks this
   * for every card on the board and the answer is a yes or a no.
   */
  hasEventSince(sessionId: string | null, ts: number, except?: string): boolean {
    const row =
      sessionId !== null
        ? this.db.prepare('SELECT 1 FROM events WHERE sessionId = ? AND ts >= ? LIMIT 1').get(sessionId, ts)
        : this.db
            .prepare('SELECT 1 FROM events WHERE ts >= ? AND sessionId != ? LIMIT 1')
            .get(ts, except ?? '')
    return row !== undefined
  }

  /** Events from one turn, matched on the prompt id the CLI puts on every payload. */
  listEventsForPrompt(sessionId: string, promptId: string): AgentEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE sessionId = ? ORDER BY ts').all(sessionId) as any[]
    return rows.map(hydrateEvent).filter((e) => (e.payload as any)?.prompt_id === promptId)
  }

  // --- saved layouts ---

  listLayouts(projectId: string): SavedLayout[] {
    const rows = this.db.prepare('SELECT * FROM layouts WHERE projectId = ? ORDER BY automatic DESC, savedAt DESC')
      .all(projectId) as any[]
    return rows.map(hydrateLayout)
  }

  getLayout(id: string): SavedLayout | undefined {
    const row = this.db.prepare('SELECT * FROM layouts WHERE id = ?').get(id) as any
    return row ? hydrateLayout(row) : undefined
  }

  /**
   * Save a set of positions, replacing any earlier save under the same name in the same project.
   *
   * The automatic one is keyed by project rather than by name so it is always overwritten, which
   * is what makes it a single step back rather than a growing pile of snapshots nobody asked for.
   */
  saveLayout(layout: SavedLayout) {
    /*
     * One saved layout per style, plus one per name.
     *
     * A layout based on a style replaces the previous version of that style, because it is "my
     * Tree" rather than "another Tree": keeping every edit would fill the rail with boards nobody
     * named and nobody could tell apart.
     */
    const existing = layout.automatic
      ? (this.db.prepare('SELECT id FROM layouts WHERE projectId = ? AND automatic = 1').get(layout.projectId) as any)
      : layout.basedOn
        ? (this.db.prepare('SELECT id FROM layouts WHERE projectId = ? AND basedOn = ?')
            .get(layout.projectId, layout.basedOn) as any)
        : (this.db.prepare('SELECT id FROM layouts WHERE projectId = ? AND name = ? AND automatic = 0 AND basedOn IS NULL')
            .get(layout.projectId, layout.name) as any)
    const id = existing?.id ?? layout.id
    this.db.prepare(`
      INSERT INTO layouts (id,projectId,name,automatic,basedOn,positions,savedAt)
      VALUES (@id,@projectId,@name,@automatic,@basedOn,@positions,@savedAt)
      ON CONFLICT(id) DO UPDATE SET name=@name, basedOn=@basedOn, positions=@positions, savedAt=@savedAt
    `).run({
      ...layout,
      id,
      automatic: layout.automatic ? 1 : 0,
      positions: JSON.stringify(layout.positions),
    })
    return id
  }

  deleteLayout(id: string) {
    this.db.prepare('DELETE FROM layouts WHERE id = ?').run(id)
  }

  /**
   * Delete events older than `olderThanMs`, in batches, and return how many went.
   *
   * Nothing pruned this table until 2026-09-08, when it held 234,883 rows and 1,026 MB from about a
   * month of use. A row is a tool call, so the rate belongs to the CLI and Garden does not get to
   * make a busy card quieter; what Garden decides is how long a row is kept. Fourteen days settles
   * the table at roughly a fortnight of traffic rather than letting it grow without a ceiling.
   *
   * Batched, and this is not a style choice. A single DELETE across six figures of rows on a
   * multi-gigabyte database takes a write lock the server needs to answer anything at all, and doing
   * exactly that earlier the same day made the owner's board stop responding while it ran. Each
   * batch is its own short transaction, and the caller sleeps between them.
   *
   * What this costs: the pipeline stages and the image list for a run older than the window go
   * blank, both being computed from events. History pages do not, because they are projected from
   * the `work` table, which nothing prunes.
   */
  pruneEventsBatch(olderThanMs: number, batch = 2000): number {
    const cutoff = Date.now() - olderThanMs
    const info = this.db
      .prepare('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ? LIMIT ?)')
      .run(cutoff, batch)
    return info.changes
  }

  insertEvent(e: AgentEvent) {
    this.db.prepare(`
      INSERT INTO events (id,sessionId,ts,type,provenance,payload)
      VALUES (@id,@sessionId,@ts,@type,@provenance,@payload)
    `).run({ ...e, payload: JSON.stringify(e.payload) })
  }

  // --- transcript archive ---

  /**
   * Insert or refresh one archived transcript, keyed on its source path rather than a caller-
   * supplied id, so the archiver can re-run over the same file forever without ever cloning the
   * row. Returns the row's id, new or existing.
   */
  upsertTranscript(t: Omit<TranscriptRecord, 'id'>): string {
    const existing = this.db.prepare('SELECT id FROM transcripts WHERE sourcePath = ?')
      .get(t.sourcePath) as { id: string } | undefined
    const id = existing?.id ?? randomUUID()
    this.db.prepare(`
      INSERT INTO transcripts (id,sessionId,agentId,sourcePath,slug,claudeSessionId,bytes,lineCount,capturedAt,content,meta)
      VALUES (@id,@sessionId,@agentId,@sourcePath,@slug,@claudeSessionId,@bytes,@lineCount,@capturedAt,@content,@meta)
      ON CONFLICT(id) DO UPDATE SET
        sessionId=@sessionId, agentId=@agentId, slug=@slug, claudeSessionId=@claudeSessionId,
        bytes=@bytes, lineCount=@lineCount, capturedAt=@capturedAt, content=@content, meta=@meta
    `).run({ ...t, id })
    return id
  }

  /**
   * What the archive already holds for one file on disk, content included. archiveOnce uses this
   * both to decide whether a re-scan can skip the file (comparing bytes) and, in tests, to prove
   * the archived copy matches the source.
   */
  getTranscriptBySource(sourcePath: string): TranscriptRecord | undefined {
    const row = this.db.prepare('SELECT * FROM transcripts WHERE sourcePath = ?')
      .get(sourcePath) as TranscriptRecord | undefined
    return row
  }

  /**
   * How many bytes the archive already holds for one file, and nothing else.
   *
   * archiveOnce asks this about every file it finds, on every tick, and it only ever wants the
   * number. Asking `getTranscriptBySource` instead pulled the whole `content` column with it, up to
   * 25 MB of transcript per row, decoded into a JavaScript string and thrown away unread. Measured
   * over the 3293 rows in the owner's database on 2026-08-31: 15.8 seconds and 396 MB of peak RSS
   * for the wide query, against 55 milliseconds and 150 MB for this one. better-sqlite3 is
   * synchronous, so those 15.8 seconds were also 15.8 seconds in which the server answered nothing.
   */
  transcriptBytesBySource(sourcePath: string): number | undefined {
    const row = this.db.prepare('SELECT bytes FROM transcripts WHERE sourcePath = ?')
      .get(sourcePath) as { bytes: number } | undefined
    return row?.bytes
  }

  /** Newest archived transcripts first, without the raw jsonl content. */
  listTranscripts(limit = 200): TranscriptSummary[] {
    return this.db.prepare(
      'SELECT id,sessionId,agentId,sourcePath,slug,claudeSessionId,bytes,lineCount,capturedAt,meta FROM transcripts ORDER BY capturedAt DESC LIMIT ?',
    ).all(limit) as TranscriptSummary[]
  }

  /** How much of the owner's Claude Code history the archive is holding, for a status readout. */
  transcriptStats(): { count: number; bytes: number } {
    const row = this.db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(bytes),0) as bytes FROM transcripts')
      .get() as { count: number; bytes: number }
    return row
  }
}

function hydrateChannel(row: any): Channel {
  return {
    ...row,
    sessionId: row.sessionId ?? null,
    path: row.path ?? null,
    fontSize: row.fontSize ?? null,
  }
}

function hydrateDoc(row: any): DocCard {
  return {
    ...row,
    collapsed: !!row.collapsed,
    manualPos: !!row.manualPos,
    external: !!row.external,
    ownerId: row.ownerId ?? null,
    web: row.web ?? null,
    kind: row.kind ?? 'text',
    size: row.size ?? 'normal',
    fontSize: row.fontSize ?? null,
    // The column is webGroup because `group` is a SQL reserved word, but the card exposes it as
    // `group`. Missing this mapping sent every card to the client without its column, so no
    // header could be drawn and the feature looked unimplemented while the data was correct.
    group: row.webGroup ?? null,
    images: parseImages(row.images),
  }
}

/** A row written before this column existed simply has no images, which is not the same as none. */
function parseImages(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function hydrateLayout(row: any): SavedLayout {
  let positions: SavedLayout['positions'] = []
  try {
    const parsed = JSON.parse(row.positions)
    if (Array.isArray(parsed)) positions = parsed
  } catch {
    // A layout that will not parse restores nothing rather than restoring rubbish.
  }
  return { ...row, automatic: !!row.automatic, basedOn: row.basedOn ?? null, positions }
}

function hydrateEvent(row: any): AgentEvent {
  let payload: unknown = null
  try {
    payload = JSON.parse(row.payload)
  } catch {
    // A payload that will not parse is still an event that happened, so the row is kept and the
    // contents are dropped rather than the whole record.
  }
  return { ...row, payload }
}

/**
 * A task row as the rest of the server reads it.
 *
 * Two JSON columns, and both fall back to something usable rather than to null. An empty territory
 * means "none declared", which every caller already handles as no restriction; a territory of null
 * would be a third case that means the same thing and would have to be handled everywhere.
 */
function hydrateTask(row: any): TaskContract {
  let territory: string[] = []
  try {
    const parsed = JSON.parse(row.territory ?? '[]')
    if (Array.isArray(parsed)) territory = parsed.map(String)
  } catch {
    // A territory that will not parse is treated as none declared. The alternative is a card that
    // can write nowhere because of a bad row, which fails in the direction that stops work.
  }
  let acceptanceRef: { path: string; sha256: string } | null = null
  try {
    acceptanceRef = row.acceptanceRef ? JSON.parse(row.acceptanceRef) : null
  } catch {
    acceptanceRef = null
  }
  return {
    ...row,
    territory,
    acceptanceRef,
    state: row.state as TaskState,
  }
}

function hydrateReassignment(row: any): TaskReassignment {
  return { ...row }
}

function hydrateWire(row: any): Wire {
  return { ...row, bidirectional: !!row.bidirectional }
}

function hydrateWork(row: any): WorkRecord {
  return {
    ...row,
    // A malformed or missing value reads as nothing known, which is not the same as nothing done.
    // Both of these are counted by `hasSubstance` with a bare `.length`, so a row from a build
    // that predates the column has to come back as an empty array here and not as null.
    filesTouched: stringList(row.filesTouched),
    tasksCompleted: stringList(row.tasksCompleted),
    promptId: row.promptId ?? null,
    parentId: row.parentId ?? null,
  }
}

/** A JSON array of strings, back from the text it is stored as, or empty if it is anything else. */
function stringList(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * A card's owned paths, back from the JSON text they are stored as.
 *
 * Anything that is not a clean list of strings reads as no limit rather than as an empty list. The
 * two mean opposite things: null is "this card may edit anywhere", an empty array would be "this
 * card may edit nothing", and a half-written or hand-edited value must not silently become the
 * second one and lock a card out of its own work.
 */
function parsePaths(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) && v.every((p) => typeof p === 'string') ? v : null
  } catch {
    return null
  }
}

function hydrateSession(row: any): TerminalSession {
  return {
    ...row,
    managed: !!row.managed,
    pinned: !!row.pinned,
    manualPos: !!row.manualPos,
    collapsed: !!row.collapsed,
    color: row.color ?? null,
    role: row.role ?? null,
    kind: row.kind ?? 'session',
    waitingFor: row.waitingFor ?? null,
    statusSince: row.statusSince ?? null,
    agentId: row.agentId ?? null,
    parentId: row.parentId ?? null,
    transcriptPath: row.transcriptPath ?? null,
    size: row.size ?? 'normal',
    /*
     * Recomputed here rather than trusted from the column.
     *
     * `contextUsed` is a fraction baked at write time from whatever the window table said that
     * day, and the table has changed twice: Opus went from 200,000 to a million, and sonnet-5
     * followed it. A row written under the old table keeps the old fraction forever, which is how
     * three sonnet-5 subagents ended up pinned at a hard 100% while their own token counts proved
     * the window was bigger than that. Deriving it from the two facts that are actually stored,
     * the token count and the model, means one correction to `contextWindowFor` reaches every row
     * the next time it is read, not just the ones written after the fix.
     */
    contextUsed:
      row.tokensUsed != null && contextWindowFor(row.model ?? null) != null
        ? Math.min(1, row.tokensUsed / contextWindowFor(row.model ?? null)!)
        : (row.contextUsed ?? null),
    tokensUsed: row.tokensUsed ?? null,
    contextSource: row.contextSource ?? null,
    roleClass: row.roleClass ?? null,
    roleClassRunning: row.roleClassRunning ?? null,
    closedAt: row.closedAt ?? null,
    // A hand-edited or half-written value must not take the whole board down with it.
    ownedPaths: parsePaths(row.ownedPaths),
    generation: Number.isInteger(row.generation) ? row.generation : 0,
    // Default to allowed, so a card made before these existed behaves exactly as it did.
    canSpawnAgents: row.canSpawnAgents === undefined ? true : !!row.canSpawnAgents,
    canUseTeams: row.canUseTeams === undefined ? true : !!row.canUseTeams,
    // Null and undefined both mean this card has not answered, which is not the same as answering
    // no. Only a stored 0 or 1 becomes a boolean here.
    subagentsAllowed: row.subagentsAllowed == null ? null : !!row.subagentsAllowed,
    effort: row.effort ?? null,
    modelChoice: row.modelChoice ?? null,
    effortChoice: row.effortChoice ?? null,
    teamSize: row.teamSize ?? null,
    reportsTo: row.reportsTo ?? null,
    baseWidth: row.baseWidth ?? null,
    baseHeight: row.baseHeight ?? null,
    fontSize: row.fontSize ?? null,
    bodyView: row.bodyView === 'chat' || row.bodyView === 'terminal' ? row.bodyView : null,
  }
}
