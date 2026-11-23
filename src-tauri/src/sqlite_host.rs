//! Native SQLite behind the official client's data access layer (DAL) — port of `SQLiteHost.swift`; the JS side is
//! `host-scripts/sqlite-host.js`.
//!
//! Zalo PC 26.10 keeps every database (messages, conversations, contacts, search, …) in SQLite, served by a
//! `utility-process-sqlite` Electron utility process that the renderer reaches through a MessagePort channel. In Compola
//! `sqlite-host.js` plays that process inside each page: it answers the official channel protocol and executes every
//! statement here, through the `$znode.sqliteHost.*` bridge members ([`SqliteHost::install`]). This reproduces what the
//! official connection class does with node-sqlite3 (`main-dist/utility-process-sqlite.js`):
//!
//! - one database file per `fullname` under `<userData>/sqlite/_production/<fullname>.db` (the official
//!   `getDBFilePath`), opened read-write/create with `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`;
//! - `run` resolves `{lastID, changes}` and treats a failed UNIQUE constraint as success (the official `run` does);
//!   `runs` binds every parameter row of one prepared statement inside a transaction; `serialize` runs a list of
//!   `run` / `runs` inside a transaction; `all` / `get` / `optimized-all` return rows as objects;
//! - errors carry node-sqlite3's shape: `errno` (SQLite primary result code) and `code` (`SQLITE_CONSTRAINT`, …), with
//!   the message `"<code>: <sqlite message>"` (on the wire `"<code>:<errno>:<detail>"`, parsed back by the script);
//! - the schema-version handshake (`PRAGMA user_version` vs the version the renderer asks for) is coordinated here so
//!   two pages opening the same database cannot both run the renderer's migration.
//!
//! The official binding is SQLCipher; a database is only encrypted once the official "DB encryption" job ran on it,
//! which Compola never starts (`DB_ENCRYPTION/CHECKSTT` → not started), so files stay plain SQLite.
//!
//! Every database has its own worker thread that owns the `rusqlite::Connection` and runs jobs in FIFO order (the Swift
//! serial `DispatchQueue`): SQL never runs on the UI thread or a tokio worker, and per-database ordering is kept.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use fallible_iterator::FallibleIterator as _;
use parking_lot::Mutex;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Batch, OpenFlags};
use serde_json::{Map, Value, json};
use tokio::sync::{oneshot, watch};

use crate::bridge::Registry;
use crate::values::{ArgsExt, bytes, undef};

// MARK: Errors

/// A SQLite failure in node-sqlite3's shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SqliteError {
    /// Primary result code (`extended & 0xff`).
    pub errno: i32,
    /// node-sqlite3 code name (`SQLITE_CONSTRAINT`, …).
    pub code: String,
    /// SQLite's message (`sqlite3_errmsg`).
    pub detail: String,
}

impl SqliteError {
    fn new(errno: i32, detail: impl Into<String>) -> Self {
        let errno = if errno == 0 { SQLITE_ERROR } else { errno };
        Self { errno, code: code_name(errno).to_owned(), detail: detail.into() }
    }

    /// node-sqlite3 message: `"SQLITE_CONSTRAINT: UNIQUE constraint failed: t.id"`.
    #[allow(dead_code)] // used by tests / future callers
    pub fn message(&self) -> String {
        format!("{}: {}", self.code, self.detail)
    }

    /// Wire form for the bridge (`sqlite-host.js` parses it back into `{errno, code, message}`).
    pub fn wire(&self) -> String {
        format!("{}:{}:{}", self.code, self.errno, self.detail)
    }

    pub fn is_unique_constraint(&self) -> bool {
        self.errno == SQLITE_CONSTRAINT && self.detail.contains("UNIQUE constraint failed")
    }
}

/// What a host operation can fail with: a SQLite error (sent as `"CODE:errno:detail"`) or anything else (file system,
/// bad arguments), sent as plain text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostError {
    Sqlite(SqliteError),
    Other(String),
}

impl HostError {
    pub fn wire(&self) -> String {
        match self {
            HostError::Sqlite(e) => e.wire(),
            HostError::Other(m) => m.clone(),
        }
    }

    #[allow(dead_code)] // used by tests / future callers
    pub fn sqlite(&self) -> Option<&SqliteError> {
        match self {
            HostError::Sqlite(e) => Some(e),
            HostError::Other(_) => None,
        }
    }

    fn closed() -> Self {
        HostError::Sqlite(SqliteError::new(SQLITE_MISUSE, "Database is closed"))
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.wire())
    }
}

impl From<SqliteError> for HostError {
    fn from(e: SqliteError) -> Self {
        HostError::Sqlite(e)
    }
}

impl From<rusqlite::Error> for HostError {
    fn from(e: rusqlite::Error) -> Self {
        HostError::Sqlite(sqlite_error(e))
    }
}

const SQLITE_ERROR: i32 = 1;
const SQLITE_CONSTRAINT: i32 = 19;
const SQLITE_MISUSE: i32 = 21;

fn errstr(code: i32) -> String {
    // SAFETY: sqlite3_errstr returns a static, NUL-terminated English string (or null).
    unsafe {
        let p = rusqlite::ffi::sqlite3_errstr(code);
        if p.is_null() { "unknown error".into() } else { std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned() }
    }
}

fn sqlite_error(e: rusqlite::Error) -> SqliteError {
    match e {
        rusqlite::Error::SqliteFailure(err, msg) => {
            let errno = err.extended_code & 0xff;
            let errno = if errno == 0 { SQLITE_ERROR } else { errno };
            SqliteError::new(errno, msg.unwrap_or_else(|| errstr(errno)))
        }
        rusqlite::Error::SqlInputError { error, msg, .. } => SqliteError::new(error.extended_code & 0xff, msg),
        other => SqliteError::new(SQLITE_ERROR, other.to_string()),
    }
}

/// node-sqlite3's `code` strings for the primary result codes.
pub fn code_name(errno: i32) -> &'static str {
    match errno {
        1 => "SQLITE_ERROR",
        2 => "SQLITE_INTERNAL",
        3 => "SQLITE_PERM",
        4 => "SQLITE_ABORT",
        5 => "SQLITE_BUSY",
        6 => "SQLITE_LOCKED",
        7 => "SQLITE_NOMEM",
        8 => "SQLITE_READONLY",
        9 => "SQLITE_INTERRUPT",
        10 => "SQLITE_IOERR",
        11 => "SQLITE_CORRUPT",
        12 => "SQLITE_NOTFOUND",
        13 => "SQLITE_FULL",
        14 => "SQLITE_CANTOPEN",
        15 => "SQLITE_PROTOCOL",
        16 => "SQLITE_EMPTY",
        17 => "SQLITE_SCHEMA",
        18 => "SQLITE_TOOBIG",
        19 => "SQLITE_CONSTRAINT",
        20 => "SQLITE_MISMATCH",
        21 => "SQLITE_MISUSE",
        22 => "SQLITE_NOLFS",
        23 => "SQLITE_AUTH",
        24 => "SQLITE_FORMAT",
        25 => "SQLITE_RANGE",
        26 => "SQLITE_NOTADB",
        27 => "SQLITE_NOTICE",
        28 => "SQLITE_WARNING",
        100 => "SQLITE_ROW",
        101 => "SQLITE_DONE",
        _ => "SQLITE_ERROR",
    }
}

// MARK: Statements

/// One statement: SQL text + positional parameters (JS values as the bridge decodes them).
#[derive(Clone, Debug, Default)]
pub struct Statement {
    pub query: String,
    pub params: Vec<Value>,
}

impl Statement {
    #[allow(dead_code)] // used by tests / future callers
    pub fn new(query: impl Into<String>, params: Vec<Value>) -> Self {
        Self { query: query.into(), params }
    }
}

/// An item of `serialize`.
#[derive(Clone, Debug)]
pub enum SerializedItem {
    Run(Statement),
    Runs { query: String, rows: Vec<Vec<Value>> },
}

/// A result row: column name → JS value (INTEGER → number, REAL → number, TEXT → string, BLOB → `{__bytes}`,
/// NULL → null).
pub type Row = Map<String, Value>;

// MARK: Connections

type Job = Box<dyn FnOnce(&mut rusqlite::Connection) + Send>;

enum Msg {
    Job(Job),
    Close(Option<oneshot::Sender<()>>),
}

/// A database's worker thread (the Swift serial queue) and its pool flag.
struct Connection {
    tx: mpsc::Sender<Msg>,
    sessional: AtomicBool,
}

impl Connection {
    /// Runs `body` on the worker after every job queued before it.
    async fn run<T, F>(&self, body: F) -> Result<T, HostError>
    where
        T: Send + 'static,
        F: FnOnce(&mut rusqlite::Connection) -> Result<T, HostError> + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        let job: Job = Box::new(move |conn| {
            let result = catch_unwind(AssertUnwindSafe(|| body(conn)))
                .unwrap_or_else(|_| Err(HostError::Other("sqlite host: statement panicked".into())));
            let _ = tx.send(result);
        });
        self.tx.send(Msg::Job(job)).map_err(|_| HostError::closed())?;
        rx.await.unwrap_or_else(|_| Err(HostError::closed()))
    }

    /// Closes the database after the queued jobs; `wait` resolves once it is closed.
    fn close(&self, wait: Option<oneshot::Sender<()>>) {
        let _ = self.tx.send(Msg::Close(wait));
    }
}

/// Opens the database on a new worker thread; resolves once it is open (or failed to).
async fn spawn_connection(name: &str, path: PathBuf, sessional: bool) -> Result<Connection, HostError> {
    let (tx, rx) = mpsc::channel::<Msg>();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), HostError>>();
    std::thread::Builder::new()
        .name(format!("compola-sqlite-{name}"))
        .spawn(move || {
            let mut conn = match open_connection(&path) {
                Ok(c) => {
                    let _ = ready_tx.send(Ok(()));
                    c
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            while let Ok(msg) = rx.recv() {
                match msg {
                    Msg::Job(job) => job(&mut conn),
                    Msg::Close(wait) => {
                        drop(conn);
                        if let Some(w) = wait {
                            let _ = w.send(());
                        }
                        return;
                    }
                }
            }
        })
        .map_err(|e| HostError::Other(format!("sqlite host: cannot start worker: {e}")))?;
    ready_rx.await.unwrap_or_else(|_| Err(HostError::Other("sqlite host: worker died".into())))?;
    Ok(Connection { tx, sessional: AtomicBool::new(sessional) })
}

fn open_connection(path: &Path) -> Result<rusqlite::Connection, HostError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE
        | OpenFlags::SQLITE_OPEN_FULL_MUTEX;
    let conn = rusqlite::Connection::open_with_flags(path, flags)?;
    // The official connection: WAL, journal_size_limit, busy_timeout, synchronous NORMAL, …
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; \
         PRAGMA journal_size_limit=67108864; PRAGMA temp_store=MEMORY;",
    )?;
    // Beyond the official connection (speed only, same data): a 32 MB page cache instead of SQLite's 2 MB default,
    // reads through a 256 MB memory map, and room for the DAL's repeated statements in the prepared-statement cache.
    conn.execute_batch("PRAGMA cache_size=-32768; PRAGMA mmap_size=268435456;")?;
    conn.set_prepared_statement_cache_capacity(256);
    Ok(conn)
}

#[derive(Default)]
struct State {
    connections: HashMap<String, Arc<Connection>>,
    /// Schema-version handshakes in flight: later openers wait until the value turns `true`.
    migrations: HashMap<String, watch::Sender<bool>>,
}

// MARK: Host

pub struct SqliteHost {
    /// The directory that holds the database files (`<userData>/sqlite/_production`).
    pub root: PathBuf,
    state: Mutex<State>,
}

impl SqliteHost {
    pub fn new(root: PathBuf) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&root);
        Arc::new(Self { root, state: Mutex::new(State::default()) })
    }

    // ---- files ----

    /// `<root>/<fullname>.db` (a fullname may hold path components: partitioned databases live in sub-directories).
    pub fn file_path(&self, fullname: &str) -> PathBuf {
        let mut path = self.base_path(fullname).into_os_string();
        path.push(".db");
        PathBuf::from(path)
    }

    /// `<root>/<fullname>` without the extension.
    fn base_path(&self, fullname: &str) -> PathBuf {
        let mut path = self.root.clone();
        for part in parts(fullname) {
            path.push(part);
        }
        path
    }

    // ---- open / close ----

    /// Opens (creating) the database and returns its `PRAGMA user_version`. `requested_version` `None` = whatever the
    /// file has (the official `null` version). `migrate` is true when the file is at another version and this caller
    /// must run the renderer's schema migration (`NEED-SCHEMA-MIGRATION`); it then calls [`Self::migrated`]. A second
    /// opener during that time waits and gets `migrate: false` (once the file is at the version it asks for).
    pub async fn open(&self, fullname: &str, requested_version: Option<i64>, sessional: bool) -> Result<(i64, bool), HostError> {
        let name = sanitized(fullname);
        let connection = self.connect(&name, sessional).await?;
        loop {
            loop {
                let pending = self.state.lock().migrations.get(&name).map(watch::Sender::subscribe);
                let Some(mut rx) = pending else { break };
                let _ = rx.wait_for(|done| *done).await;
            }
            let current = connection.run(|c| user_version(c)).await?;
            let requested = requested_version.unwrap_or(current).max(1);
            if current == requested {
                return Ok((current, false));
            }
            let mut st = self.state.lock();
            // Another opener started the handshake while we read the version: wait for it, then look again.
            if st.migrations.contains_key(&name) {
                continue;
            }
            st.migrations.insert(name, watch::channel(false).0);
            return Ok((current, true));
        }
    }

    /// The renderer finished (or failed) the schema migration started by [`Self::open`].
    pub fn migrated(&self, fullname: &str) {
        let name = sanitized(fullname);
        if let Some(pending) = self.state.lock().migrations.remove(&name) {
            pending.send_replace(true);
        }
    }

    pub async fn close(&self, fullname: &str) {
        let name = sanitized(fullname);
        let Some(connection) = self.state.lock().connections.remove(&name) else { return };
        let (tx, rx) = oneshot::channel();
        connection.close(Some(tx));
        let _ = rx.await;
    }

    /// Closes every database (after the statements queued on each) and waits for it.
    pub async fn close_all_async(&self) {
        let names: Vec<String> = self.state.lock().connections.keys().cloned().collect();
        for name in names {
            self.close(&name).await;
        }
    }

    /// Closes every database without waiting (account reset from the main process); each worker closes its database
    /// once the statements already queued on it ran.
    pub fn close_all(&self) {
        let connections: Vec<Arc<Connection>> = self.state.lock().connections.drain().map(|(_, c)| c).collect();
        for connection in connections {
            connection.close(None);
        }
    }

    pub async fn close_sessional(&self) {
        let names: Vec<String> = {
            let st = self.state.lock();
            st.connections.iter().filter(|(_, c)| c.sessional.load(Ordering::Relaxed)).map(|(k, _)| k.clone()).collect()
        };
        for name in names {
            self.close(&name).await;
        }
    }

    /// Closes and removes the database and its WAL / shm files.
    pub async fn delete(&self, fullname: &str) {
        self.close(fullname).await;
        let path = self.file_path(fullname);
        for suffix in ["", "-shm", "-wal"] {
            let mut p = path.clone().into_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(p));
        }
    }

    /// Official `DAL_UTILITY/GET_PARTITION_KEYS`: `[""]` when `<fullname>.db` exists, else the names of the `.db` files
    /// in every sub-directory of `<root>/<fullname>/` (sorted).
    pub fn partition_keys(&self, fullname: &str) -> Vec<String> {
        if self.file_path(fullname).exists() {
            return vec![String::new()];
        }
        let base = self.base_path(fullname);
        let Ok(groups) = std::fs::read_dir(&base) else { return Vec::new() };
        let mut keys = Vec::new();
        for group in groups.flatten() {
            let dir = group.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&dir) else { continue };
            for file in files.flatten() {
                let file_name = file.file_name().to_string_lossy().into_owned();
                if let Some(key) = file_name.strip_suffix(".db") {
                    keys.push(key.to_owned());
                }
            }
        }
        keys.sort();
        keys
    }

    async fn connect(&self, name: &str, sessional: bool) -> Result<Arc<Connection>, HostError> {
        if let Some(existing) = self.state.lock().connections.get(name).cloned() {
            if sessional {
                existing.sessional.store(true, Ordering::Relaxed);
            }
            return Ok(existing);
        }
        let path = self.file_path(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| HostError::Other(format!("sqlite host: {}: {e}", parent.display())))?;
        }
        let connection = Arc::new(spawn_connection(name, path, sessional).await?);
        let mut st = self.state.lock();
        if let Some(raced) = st.connections.get(name).cloned() {
            connection.close(None);
            if sessional {
                raced.sessional.store(true, Ordering::Relaxed);
            }
            return Ok(raced);
        }
        st.connections.insert(name.to_owned(), connection.clone());
        Ok(connection)
    }

    async fn connection(&self, fullname: &str) -> Result<Arc<Connection>, HostError> {
        let name = sanitized(fullname);
        let existing = self.state.lock().connections.get(&name).cloned();
        match existing {
            Some(c) => Ok(c),
            None => self.connect(&name, false).await,
        }
    }

    // ---- statements (the official `libMethod`s) ----

    /// `run`: `{lastID, changes}`; a failed UNIQUE constraint still resolves (official behaviour).
    pub async fn run(&self, fullname: &str, statement: Statement) -> Result<Row, HostError> {
        let connection = self.connection(fullname).await?;
        connection
            .run(move |c| {
                match execute(c, &statement) {
                    Err(HostError::Sqlite(e)) if e.is_unique_constraint() => {}
                    other => other?,
                }
                let mut out = Map::new();
                out.insert("lastID".into(), json!(c.last_insert_rowid()));
                out.insert("changes".into(), json!(c.changes() as i64));
                Ok(out)
            })
            .await
    }

    /// `runs`: one prepared statement bound with every row of `rows`, in a transaction.
    pub async fn runs(&self, fullname: &str, query: String, rows: Vec<Vec<Value>>) -> Result<(), HostError> {
        let connection = self.connection(fullname).await?;
        connection.run(move |c| transaction(c, |c| run_rows(c, &query, &rows))).await
    }

    /// `serialize`: a list of `run` / `runs` in one transaction.
    pub async fn serialize(&self, fullname: &str, items: Vec<SerializedItem>) -> Result<(), HostError> {
        let connection = self.connection(fullname).await?;
        connection
            .run(move |c| {
                transaction(c, |c| {
                    for item in &items {
                        match item {
                            SerializedItem::Run(statement) => execute(c, statement)?,
                            SerializedItem::Runs { query, rows } => run_rows(c, query, rows)?,
                        }
                    }
                    Ok(())
                })
            })
            .await
    }

    pub async fn all(&self, fullname: &str, statement: Statement) -> Result<Vec<Row>, HostError> {
        let connection = self.connection(fullname).await?;
        connection.run(move |c| select(c, &statement, None)).await
    }

    pub async fn get(&self, fullname: &str, statement: Statement) -> Result<Option<Row>, HostError> {
        let connection = self.connection(fullname).await?;
        connection.run(move |c| Ok(select(c, &statement, Some(1))?.into_iter().next())).await
    }

    /// `optimized-all`: every query bound with each of its parameter rows; all rows concatenated.
    pub async fn optimized_all(&self, fullname: &str, queries: Vec<String>, params: Vec<Vec<Vec<Value>>>) -> Result<Vec<Row>, HostError> {
        let connection = self.connection(fullname).await?;
        connection
            .run(move |c| {
                let mut out = Vec::new();
                for (index, query) in queries.iter().enumerate() {
                    let mut prepared = prepare(c, query)?;
                    for row in params.get(index).map(Vec::as_slice).unwrap_or_default() {
                        bind(&mut prepared, row)?;
                        out.extend(collect(&mut prepared, None)?);
                    }
                }
                Ok(out)
            })
            .await
    }

    /// The `exec` bridge member: runs `statement` (the official statement object) with `lib_method`.
    pub async fn exec(&self, fullname: &str, lib_method: &str, statement: &Map<String, Value>) -> Result<Value, HostError> {
        match lib_method {
            "run" => Ok(Value::Object(self.run(fullname, parse_statement(statement)).await?)),
            "runs" => {
                self.runs(fullname, parse_query(statement.get("query")), parse_rows(statement.get("params"))).await?;
                Ok(undef())
            }
            "all" => Ok(rows_value(self.all(fullname, parse_statement(statement)).await?)),
            "get" => Ok(self.get(fullname, parse_statement(statement)).await?.map(Value::Object).unwrap_or_else(undef)),
            "optimized-all" => {
                let queries = array(statement.get("queries")).iter().map(|q| parse_query(Some(q))).collect();
                let params = array(statement.get("params")).iter().map(|p| parse_rows(Some(p))).collect();
                Ok(rows_value(self.optimized_all(fullname, queries, params).await?))
            }
            "serialize" => {
                self.serialize(fullname, parse_serialized(statement.get("data"))).await?;
                Ok(undef())
            }
            other => Err(HostError::Other(format!("exec: unknown method {other}"))),
        }
    }

    // ---- bridge members (`$znode.sqliteHost.*`, called by sqlite-host.js) ----

    /// Registers the executor on the bridge. Results go back through the bridge's value conversion (bytes as
    /// `{__bytes}`, `undefined` as `{__undefined}`); errors as text (`"CODE:errno:detail"` for SQLite errors).
    pub fn install(self: &Arc<Self>, reg: &mut Registry) {
        let me = self.clone();
        reg.async_("$znode.sqliteHost.open", move |_, args| {
            let me = me.clone();
            async move {
                let name = args.string_at(0).ok_or("open: missing fullname")?;
                let version = args.get(1).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)));
                let sessional = args.bool_at(2).unwrap_or(false);
                let (user_version, migrate) = me.open(&name, version, sessional).await.map_err(|e| e.wire())?;
                Ok(json!({ "userVersion": user_version, "migrate": migrate }))
            }
        });
        let me = self.clone();
        reg.async_("$znode.sqliteHost.migrated", move |_, args| {
            let me = me.clone();
            async move {
                if let Some(name) = args.str_at(0) {
                    me.migrated(name);
                }
                Ok(undef())
            }
        });
        let me = self.clone();
        reg.async_("$znode.sqliteHost.exec", move |_, args| {
            let me = me.clone();
            async move {
                let (Some(name), Some(method)) = (args.string_at(0), args.string_at(1)) else {
                    return Err("exec: bad arguments".to_owned());
                };
                let statement = args.obj_at(2).cloned().unwrap_or_default();
                me.exec(&name, &method, &statement).await.map_err(|e| e.wire())
            }
        });
        let me = self.clone();
        reg.async_("$znode.sqliteHost.close", move |_, args| {
            let me = me.clone();
            async move {
                if let Some(name) = args.str_at(0) {
                    me.close(name).await;
                }
                Ok(undef())
            }
        });
        let me = self.clone();
        reg.async_("$znode.sqliteHost.delete", move |_, args| {
            let me = me.clone();
            async move {
                if let Some(name) = args.str_at(0) {
                    me.delete(name).await;
                }
                Ok(undef())
            }
        });
        let me = self.clone();
        reg.async_("$znode.sqliteHost.partitionKeys", move |_, args| {
            let me = me.clone();
            async move { Ok(json!(args.str_at(0).map(|n| me.partition_keys(n)).unwrap_or_default())) }
        });
        let me = self.clone();
        reg.async_("$znode.sqliteHost.closeSessional", move |_, _| {
            let me = me.clone();
            async move {
                me.close_sessional().await;
                Ok(undef())
            }
        });
        let me = self.clone();
        reg.async_("$znode.sqliteHost.closeAll", move |_, _| {
            let me = me.clone();
            async move {
                me.close_all_async().await;
                Ok(undef())
            }
        });
    }
}

// MARK: Names

fn parts(fullname: &str) -> impl Iterator<Item = &str> {
    fullname.split('/').filter(|p| !p.is_empty() && *p != "." && *p != "..")
}

fn sanitized(fullname: &str) -> String {
    parts(fullname).collect::<Vec<_>>().join("/")
}

// MARK: Official statement objects

/// `{query: {query, params: <count>}, params: [...]}`; `query` may also be the SQL text.
fn parse_query(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o.get("query").and_then(Value::as_str).unwrap_or_default().to_owned(),
        _ => String::new(),
    }
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
}

fn parse_statement(object: &Map<String, Value>) -> Statement {
    Statement { query: parse_query(object.get("query")), params: array(object.get("params")).to_vec() }
}

fn parse_rows(value: Option<&Value>) -> Vec<Vec<Value>> {
    array(value).iter().map(|row| array(Some(row)).to_vec()).collect()
}

/// `serialize`'s `data`: `[{method: "run"|"runs", query, params}]` (all objects, or nothing — as Swift's cast).
fn parse_serialized(value: Option<&Value>) -> Vec<SerializedItem> {
    let items = array(value);
    if items.iter().any(|i| !i.is_object()) {
        return Vec::new();
    }
    items
        .iter()
        .filter_map(Value::as_object)
        .map(|item| {
            if item.get("method").and_then(Value::as_str) == Some("runs") {
                SerializedItem::Runs { query: parse_query(item.get("query")), rows: parse_rows(item.get("params")) }
            } else {
                SerializedItem::Run(parse_statement(item))
            }
        })
        .collect()
}

fn rows_value(rows: Vec<Row>) -> Value {
    Value::Array(rows.into_iter().map(Value::Object).collect())
}

// MARK: SQLite plumbing (always on the connection's worker)

fn user_version(c: &rusqlite::Connection) -> Result<i64, HostError> {
    let mut prepared = prepare(c, "PRAGMA user_version;")?;
    let mut rows = prepared.raw_query();
    Ok(match rows.next()? {
        Some(row) => match row.get_ref(0)? {
            ValueRef::Integer(i) => i,
            _ => 0,
        },
        None => 0,
    })
}

fn transaction<F>(c: &rusqlite::Connection, body: F) -> Result<(), HostError>
where
    F: FnOnce(&rusqlite::Connection) -> Result<(), HostError>,
{
    c.execute_batch("BEGIN TRANSACTION")?;
    match body(c) {
        Ok(()) => {
            if let Err(e) = c.execute_batch("COMMIT") {
                let _ = c.execute_batch("ROLLBACK");
                return Err(e.into());
            }
            Ok(())
        }
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// The first statement of `sql` (like `sqlite3_prepare_v2`, the rest of the text is ignored).
/// A prepared statement: from the connection's statement cache when the text is a single statement (the DAL repeats
/// the same queries constantly, so this skips SQLite's parse/plan on every call), else parsed through `Batch`.
enum Prepared<'c> {
    Cached(rusqlite::CachedStatement<'c>),
    Plain(rusqlite::Statement<'c>),
}

impl<'c> std::ops::Deref for Prepared<'c> {
    type Target = rusqlite::Statement<'c>;
    fn deref(&self) -> &Self::Target {
        match self {
            Prepared::Cached(s) => s,
            Prepared::Plain(s) => s,
        }
    }
}

impl std::ops::DerefMut for Prepared<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        match self {
            Prepared::Cached(s) => s,
            Prepared::Plain(s) => s,
        }
    }
}

fn prepare<'c>(c: &'c rusqlite::Connection, sql: &str) -> Result<Prepared<'c>, HostError> {
    // Multiple statements, empty text or a syntax error: the uncached path keeps the original behaviour and errors.
    if let Ok(statement) = c.prepare_cached(sql) {
        return Ok(Prepared::Cached(statement));
    }
    match Batch::new(c, sql).next()? {
        Some(statement) => Ok(Prepared::Plain(statement)),
        // Empty text / comments only: Swift's prepare fails with the connection's (OK) state.
        None => Err(SqliteError::new(SQLITE_ERROR, "not an error").into()),
    }
}

/// Runs `statement`: with parameters a single statement; without, every statement of the text (pragmas, DDL).
fn execute(c: &rusqlite::Connection, statement: &Statement) -> Result<(), HostError> {
    if statement.params.is_empty() {
        let mut batch = Batch::new(c, &statement.query);
        while let Some(mut prepared) = batch.next()? {
            step_to_end(&mut prepared)?;
        }
        return Ok(());
    }
    let mut prepared = prepare(c, &statement.query)?;
    bind(&mut prepared, &statement.params)?;
    step_to_end(&mut prepared)
}

fn run_rows(c: &rusqlite::Connection, query: &str, rows: &[Vec<Value>]) -> Result<(), HostError> {
    let mut prepared = prepare(c, query)?;
    for row in rows {
        bind(&mut prepared, row)?;
        step_to_end(&mut prepared)?;
    }
    Ok(())
}

fn select(c: &rusqlite::Connection, statement: &Statement, limit: Option<usize>) -> Result<Vec<Row>, HostError> {
    let mut prepared = prepare(c, &statement.query)?;
    bind(&mut prepared, &statement.params)?;
    collect(&mut prepared, limit)
}

fn step_to_end(prepared: &mut rusqlite::Statement<'_>) -> Result<(), HostError> {
    let mut rows = prepared.raw_query();
    while rows.next()?.is_some() {}
    Ok(())
}

fn collect(prepared: &mut rusqlite::Statement<'_>, limit: Option<usize>) -> Result<Vec<Row>, HostError> {
    let names: Vec<String> = prepared.column_names().into_iter().map(str::to_owned).collect();
    let mut out = Vec::new();
    let mut rows = prepared.raw_query();
    while let Some(row) = rows.next()? {
        let mut object = Map::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            object.insert(name.clone(), js_value(row.get_ref(i)?));
        }
        out.push(object);
        if limit.is_some_and(|l| out.len() >= l) {
            break;
        }
    }
    Ok(out)
}

/// A column value as JS sees it: INTEGER → number (int64 written exactly; JS rounds beyond 2^53 as with Swift's
/// JSON), REAL → number, TEXT → string (up to the first NUL, invalid UTF-8 repaired), BLOB → `Uint8Array`, NULL → null.
fn js_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => {
            let end = t.iter().position(|&b| b == 0).unwrap_or(t.len());
            Value::String(String::from_utf8_lossy(&t[..end]).into_owned())
        }
        ValueRef::Blob(b) => bytes(b),
    }
}

/// Binds JS values the way node-sqlite3 does: numbers as INTEGER / REAL (integral doubles below 9e15 as INTEGER),
/// booleans as 0 / 1, strings as TEXT, bytes (`{__bytes}`) as BLOB, null / undefined / anything else as NULL. Every
/// parameter of the statement is bound; missing ones as NULL, extra ones ignored.
fn bind(prepared: &mut rusqlite::Statement<'_>, params: &[Value]) -> Result<(), HostError> {
    for index in 0..prepared.parameter_count() {
        prepared.raw_bind_parameter(index + 1, sql_value(params.get(index)))?;
    }
    Ok(())
}

fn sql_value(value: Option<&Value>) -> SqlValue {
    match value {
        Some(Value::Bool(b)) => SqlValue::Integer(i64::from(*b)),
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                if f.round() == f && f.abs() < 9.0e15 { SqlValue::Integer(f as i64) } else { SqlValue::Real(f) }
            } else {
                SqlValue::Null
            }
        }
        Some(Value::String(s)) => SqlValue::Text(s.clone()),
        Some(Value::Object(o)) => match o.get("__bytes").and_then(Value::as_str) {
            Some(b64) => SqlValue::Blob(crate::values::unb64(b64)),
            None => SqlValue::Null,
        },
        _ => SqlValue::Null,
    }
}

// MARK: Tests (port of `SQLiteHostTests.swift`)

#[cfg(test)]
mod tests {
    use super::*;

    struct TempHost {
        host: Arc<SqliteHost>,
    }

    impl Drop for TempHost {
        fn drop(&mut self) {
            self.host.close_all();
            let _ = std::fs::remove_dir_all(&self.host.root);
        }
    }

    impl std::ops::Deref for TempHost {
        type Target = Arc<SqliteHost>;
        fn deref(&self) -> &Arc<SqliteHost> {
            &self.host
        }
    }

    fn host() -> TempHost {
        let root = std::env::temp_dir().join(format!("CompolaSQLiteHostTests-{}", uuid::Uuid::new_v4()));
        TempHost { host: SqliteHost::new(root) }
    }

    fn st(query: &str, params: Vec<Value>) -> Statement {
        Statement::new(query, params)
    }

    #[tokio::test]
    async fn run_reports_last_id_and_changes_and_tolerates_unique_failures() {
        let h = host();
        h.open("user/messages", None, false).await.unwrap();
        h.run("user/messages", st("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, data BLOB)", vec![])).await.unwrap();
        let first = h.run("user/messages", st("INSERT INTO t (name) VALUES (?)", vec![json!("a")])).await.unwrap();
        assert_eq!(first["lastID"], json!(1));
        assert_eq!(first["changes"], json!(1));
        // The official `run` resolves on a failed UNIQUE constraint instead of rejecting.
        let duplicate = h.run("user/messages", st("INSERT INTO t (name) VALUES (?)", vec![json!("a")])).await.unwrap();
        assert_eq!(duplicate["changes"], json!(0));
        // Other errors carry node-sqlite3's errno / code and the "CODE: message" text.
        let error = h.all("user/messages", st("SELECT * FROM nope", vec![])).await.unwrap_err();
        let error = error.sqlite().expect("a SQLite error").clone();
        assert_eq!(error.errno, 1);
        assert_eq!(error.code, "SQLITE_ERROR");
        assert!(error.message().starts_with("SQLITE_ERROR: no such table"), "{}", error.message());
        assert_eq!(error.wire(), "SQLITE_ERROR:1:no such table: nope");
        // A UNIQUE failure inside `serialize` is not tolerated (Swift: only `run` swallows it).
        let err = h
            .serialize("user/messages", vec![SerializedItem::Run(st("INSERT INTO t (name) VALUES (?)", vec![json!("a")]))])
            .await
            .unwrap_err();
        let err = err.sqlite().unwrap();
        assert_eq!((err.errno, err.code.as_str()), (19, "SQLITE_CONSTRAINT"));
        assert!(err.is_unique_constraint());
    }

    #[tokio::test]
    async fn runs_serialize_all_get_and_optimized_all() {
        let h = host();
        h.run("shared/contacts", st("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, data BLOB)", vec![]))
            .await
            .unwrap();
        h.runs(
            "shared/contacts",
            "INSERT INTO t (name, score, data) VALUES (?, ?, ?)".into(),
            vec![vec![json!("a"), json!(1.5), bytes(&[1, 2, 3])], vec![json!("b"), json!(true), Value::Null]],
        )
        .await
        .unwrap();
        h.serialize(
            "shared/contacts",
            vec![
                SerializedItem::Run(st("INSERT INTO t (name) VALUES (?)", vec![json!("c")])),
                SerializedItem::Runs { query: "INSERT INTO t (name) VALUES (?)".into(), rows: vec![vec![json!("d")], vec![json!("e")]] },
            ],
        )
        .await
        .unwrap();
        let rows = h.all("shared/contacts", st("SELECT id, name, score, data FROM t ORDER BY id", vec![])).await.unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0]["name"], json!("a"));
        assert_eq!(rows[0]["score"].as_f64(), Some(1.5));
        assert_eq!(rows[0]["data"], bytes(&[1, 2, 3]));
        // Booleans bind as 1; `score` has REAL affinity, so 1 comes back as a double, and nulls come back as null.
        assert!(rows[1]["score"].is_f64());
        assert_eq!(rows[1]["score"].as_f64(), Some(1.0));
        assert_eq!(rows[1]["data"], Value::Null);
        let one = h.get("shared/contacts", st("SELECT name FROM t WHERE id = ?", vec![json!(3)])).await.unwrap();
        assert_eq!(one.unwrap()["name"], json!("c"));
        let none = h.get("shared/contacts", st("SELECT name FROM t WHERE id = ?", vec![json!(99)])).await.unwrap();
        assert!(none.is_none());
        let many = h
            .optimized_all("shared/contacts", vec!["SELECT name FROM t WHERE id = ?".into()], vec![vec![vec![json!(1)], vec![json!(2)]]])
            .await
            .unwrap();
        assert_eq!(many.iter().map(|r| r["name"].clone()).collect::<Vec<_>>(), vec![json!("a"), json!("b")]);
        // A failing `runs` rolls its rows back.
        let err = h
            .runs("shared/contacts", "INSERT INTO t (id, name) VALUES (?, ?)".into(), vec![vec![json!(100), json!("x")], vec![json!(100), json!("y")]])
            .await
            .unwrap_err();
        assert_eq!(err.sqlite().unwrap().code, "SQLITE_CONSTRAINT");
        let after = h.all("shared/contacts", st("SELECT count(*) AS n FROM t WHERE id = 100", vec![])).await.unwrap();
        assert_eq!(after[0]["n"], json!(0));
    }

    #[tokio::test]
    async fn schema_version_handshake_runs_once_and_later_openers_wait() {
        let h = host();
        // A fresh file is at version 0: the renderer asking for 3 must migrate it.
        let first = h.open("user/db", Some(3), true).await.unwrap();
        assert_eq!(first, (0, true));
        // Someone else opening meanwhile waits for the migration, then needs none.
        let other = h.host.clone();
        let waiter = tokio::spawn(async move { other.open("user/db", Some(3), false).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiter.is_finished(), "a second opener waits for the migration");
        h.run("user/db", st("PRAGMA user_version = 3;", vec![])).await.unwrap();
        h.migrated("user/db");
        let second = waiter.await.unwrap().unwrap();
        assert_eq!(second, (3, false));
        // `null` version: whatever the file has, no migration.
        let any = h.open("user/db", None, false).await.unwrap();
        assert_eq!(any, (3, false));
        // Version floor 1: a fresh file opened with `null` must be migrated to 1.
        assert_eq!(h.open("user/fresh", None, false).await.unwrap(), (0, true));
        h.migrated("user/fresh");
        h.close_sessional().await;
        assert!(!h.state.lock().connections.contains_key("user/db"));
        assert!(h.state.lock().connections.contains_key("user/fresh"));
        h.close_all_async().await;
        assert!(h.state.lock().connections.is_empty());
    }

    #[tokio::test]
    async fn files_partitions_and_delete() {
        let h = host();
        assert!(h.file_path("a/../b/c").to_string_lossy().ends_with("/a/b/c.db"));
        h.run("family/group/key1", st("CREATE TABLE t (x)", vec![])).await.unwrap();
        h.run("family/group/key2", st("CREATE TABLE t (x)", vec![])).await.unwrap();
        assert_eq!(h.partition_keys("family"), vec!["key1".to_owned(), "key2".to_owned()]);
        h.run("single", st("CREATE TABLE t (x)", vec![])).await.unwrap();
        assert_eq!(h.partition_keys("single"), vec![String::new()]);
        assert!(h.partition_keys("missing").is_empty());
        h.delete("single").await;
        assert!(!h.file_path("single").exists());
        assert!(h.partition_keys("single").is_empty());
    }

    /// The JSON layer the bridge uses: statement objects, value mapping both ways, `undefined` for an empty `get`.
    #[tokio::test]
    async fn exec_maps_js_values() {
        let h = host();
        let exec = |method: &'static str, statement: Value| {
            let h = h.host.clone();
            async move { h.exec("v", method, statement.as_object().unwrap()).await }
        };
        exec("run", json!({ "query": { "query": "CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB, n)", "params": 0 } }))
            .await
            .unwrap();
        let big: i64 = (1 << 53) + 1;
        let result = exec(
            "run",
            json!({
                "query": { "query": "INSERT INTO t VALUES (?, ?, ?, ?, ?)", "params": 5 },
                "params": [big, 2.5, "héllo", { "__bytes": "AAEC" }, { "__undefined": true }],
                "migrate": true,
            }),
        )
        .await
        .unwrap();
        assert_eq!(result, json!({ "lastID": 1, "changes": 1 }));
        // Integral doubles bind as INTEGER; booleans as 0 / 1; missing parameters as NULL.
        // (`n` has no affinity, so the bound type shows; 1e16 is past the 9e15 integer cut-off and binds as REAL.)
        exec("runs", json!({ "query": "INSERT INTO t (i, r, s, n) VALUES (?, ?, ?, ?)", "params": [[4.0, false], [5, true, null, 1e16]] }))
            .await
            .unwrap();
        let rows = exec("all", json!({ "query": "SELECT i, typeof(i) AS ti, r, s, b, n, typeof(n) AS tn FROM t ORDER BY rowid" }))
            .await
            .unwrap();
        assert_eq!(rows[0]["i"].as_i64(), Some(big), "int64 beyond 2^53 is written exactly");
        assert_eq!(rows[0]["r"], json!(2.5));
        assert_eq!(rows[0]["s"], json!("héllo"));
        assert_eq!(rows[0]["b"], bytes(&[0, 1, 2]));
        assert_eq!(rows[0]["n"], Value::Null);
        assert_eq!((rows[1]["i"].clone(), rows[1]["ti"].clone(), rows[1]["r"].as_f64()), (json!(4), json!("integer"), Some(0.0)));
        assert_eq!(rows[1]["tn"], json!("null"));
        assert_eq!(rows[2]["tn"], json!("real"));
        assert_eq!(rows[2]["n"].as_f64(), Some(1e16));
        assert_eq!(rows[2]["s"], Value::Null);
        assert_eq!(rows[2]["r"].as_f64(), Some(1.0));
        assert_eq!(exec("get", json!({ "query": "SELECT * FROM t WHERE i = ?", "params": [-1] })).await.unwrap(), undef());
        let many = exec(
            "optimized-all",
            json!({ "queries": [{ "query": "SELECT s FROM t WHERE i = ?", "params": 1 }, "SELECT 7 AS x"], "params": [[[big], [4]], [[]]] }),
        )
        .await
        .unwrap();
        assert_eq!(many, json!([{ "s": "héllo" }, { "s": null }, { "x": 7 }]));
        let serialized = exec(
            "serialize",
            json!({ "data": [
                { "method": "run", "query": { "query": "DELETE FROM t WHERE i = ?" }, "params": [4] },
                { "method": "runs", "query": "INSERT INTO t (s) VALUES (?)", "params": [["x"], ["y"]] },
            ], "migrate": false }),
        )
        .await
        .unwrap();
        assert_eq!(serialized, undef());
        assert_eq!(exec("get", json!({ "query": "SELECT count(*) AS n FROM t" })).await.unwrap(), json!({ "n": 4 }));
        let err = exec("nope", json!({})).await.unwrap_err();
        assert_eq!(err.wire(), "exec: unknown method nope");
        // Errors go over the bridge in the form sqlite-host.js parses.
        let err = exec("all", json!({ "query": "SELEC 1" })).await.unwrap_err();
        assert!(err.wire().starts_with("SQLITE_ERROR:1:near \"SELEC\""), "{}", err.wire());
    }

    /// Statements on one database run in submission order even when issued concurrently.
    #[tokio::test]
    async fn per_database_ordering() {
        let h = host();
        h.run("o", st("CREATE TABLE t (i INTEGER)", vec![])).await.unwrap();
        let inserts = (0..50).map(|i| h.run("o", st("INSERT INTO t VALUES (?)", vec![json!(i)])));
        for result in futures_util::future::join_all(inserts).await {
            result.unwrap();
        }
        let rows = h.all("o", st("SELECT i FROM t ORDER BY rowid", vec![])).await.unwrap();
        assert_eq!(rows.iter().map(|r| r["i"].as_i64().unwrap()).collect::<Vec<_>>(), (0..50).collect::<Vec<_>>());
    }
}
