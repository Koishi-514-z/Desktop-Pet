//! 记忆的 SQLite 存储

use std::{collections::HashSet, path::Path};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};

use super::maintain::{consolidation_groups, retention, should_forget};
use super::model::{
  Category, EmbeddingItem, EventAction, ForgetOptions, ListedMemory, Memory, MemoryEvent, MemoryPatch, MemorySnapshot,
  MemoryStats, NewMemory, PendingEmbedding, SearchRequest, SearchResult, SimilarMemory, SimilarRequest,
};
use super::rank::{rank, similar, Candidate, RankOptions};

/// 数据库结构版本，结构变化时递增并在 migrate 中添加迁移步骤
const SCHEMA_VERSION: i32 = 3;

/// 最多保留的变动记录条数
const MAX_EVENTS: i64 = 2000;

const MEMORY_COLUMNS: &str = "id, category, content, importance, occurred_at, created_at, updated_at, \
  last_accessed_at, access_count, source, embedding_model, archived, pinned";

/// 一次变动的上下文
#[derive(Clone, Copy, Debug)]
pub struct Change<'a> {
  /// 变动来源，如 chat:会话 id、manual、consolidate、forget
  pub source: Option<&'a str>,
  /// 同一次操作产生的变动属于同一批，撤销时整批撤销
  pub batch: Option<&'a str>,
  pub now: i64,
}

/// 撤销时读取的变动记录
struct StoredEvent {
  id: i64,
  memory_id: i64,
  action: EventAction,
  content: String,
  previous: Option<String>,
  snapshot: Option<MemorySnapshot>,
}

pub struct MemoryDb {
  conn: Connection,
}

impl MemoryDb {
  pub fn open(path: &Path) -> rusqlite::Result<Self> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Self::init(conn)
  }

  #[cfg(test)]
  pub fn open_in_memory() -> rusqlite::Result<Self> {
    Self::init(Connection::open_in_memory()?)
  }

  fn init(conn: Connection) -> rusqlite::Result<Self> {
    let db = Self { conn };
    db.migrate()?;
    Ok(db)
  }

  fn migrate(&self) -> rusqlite::Result<()> {
    let version: i32 = self.conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version < 1 {
      self.conn.execute_batch(
        "BEGIN;
        CREATE TABLE IF NOT EXISTS memories (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          category         TEXT    NOT NULL,
          content          TEXT    NOT NULL,
          importance       REAL    NOT NULL DEFAULT 0.5,
          occurred_at      INTEGER,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL,
          last_accessed_at INTEGER,
          access_count     INTEGER NOT NULL DEFAULT 0,
          source           TEXT,
          embedding        BLOB,
          embedding_model  TEXT,
          archived         INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories (category) WHERE archived = 0;
        COMMIT;",
      )?;
    }
    if version < 2 {
      // 记忆的变动记录：新增、修改、合并、删除时各记一条，便于了解记忆的来历与撤销误操作
      self.conn.execute_batch(
        "BEGIN;
        CREATE TABLE IF NOT EXISTS memory_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id  INTEGER NOT NULL,
          action     TEXT    NOT NULL,
          category   TEXT    NOT NULL,
          content    TEXT    NOT NULL,
          previous   TEXT,
          source     TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_events_memory ON memory_events (memory_id);
        COMMIT;",
      )?;
    }
    if version < 3 {
      // 固定的记忆；变动的批次、变动前的状态（用于撤销）与撤销时间
      self.conn.execute_batch(
        "BEGIN;
        ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE memory_events ADD COLUMN batch_id TEXT;
        ALTER TABLE memory_events ADD COLUMN snapshot TEXT;
        ALTER TABLE memory_events ADD COLUMN undone_at INTEGER;
        CREATE INDEX IF NOT EXISTS idx_memory_events_batch ON memory_events (batch_id);
        COMMIT;",
      )?;
    }
    self.conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
  }

  // ===== 读取 =====

  /// 获取一条未归档的记忆
  pub fn get(&self, id: i64) -> rusqlite::Result<Option<Memory>> {
    self
      .conn
      .query_row(&format!("SELECT {MEMORY_COLUMNS} FROM memories WHERE id = ?1 AND archived = 0"), [id], read_memory)
      .optional()
  }

  /// 获取一条记忆（包括已归档的）
  fn get_any(&self, id: i64) -> rusqlite::Result<Option<Memory>> {
    self
      .conn
      .query_row(&format!("SELECT {MEMORY_COLUMNS} FROM memories WHERE id = ?1"), [id], read_memory)
      .optional()
  }

  /// 批量获取未归档的记忆，按传入的顺序返回，跳过不存在的
  pub fn get_many(&self, ids: &[i64]) -> rusqlite::Result<Vec<Memory>> {
    let mut memories = Vec::new();
    for &id in ids {
      if let Some(memory) = self.get(id)? {
        memories.push(memory);
      }
    }
    Ok(memories)
  }

  /// 按更新时间从新到旧列出记忆，附带当前的记忆强度
  pub fn list(
    &self,
    category: Option<Category>,
    archived: bool,
    limit: usize,
    offset: usize,
    now: i64,
  ) -> rusqlite::Result<Vec<ListedMemory>> {
    let mut statement = self.conn.prepare(&format!(
      "SELECT {MEMORY_COLUMNS} FROM memories
       WHERE archived = ?1 AND (?2 IS NULL OR category = ?2)
       ORDER BY updated_at DESC, id DESC LIMIT ?3 OFFSET ?4"
    ))?;
    let rows = statement.query_map(
      params![archived, category.map(Category::as_str), limit as i64, offset as i64],
      read_memory,
    )?;
    rows
      .map(|row| row.map(|memory| ListedMemory { retention: retention(&memory, now), memory }))
      .collect()
  }

  pub fn stats(&self, embedding_model: Option<&str>) -> rusqlite::Result<MemoryStats> {
    let mut statement = self
      .conn
      .prepare("SELECT category, COUNT(*) FROM memories WHERE archived = 0 GROUP BY category")?;
    let counts: Vec<(String, usize)> = statement
      .query_map([], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize)))?
      .collect::<rusqlite::Result<_>>()?;

    let by_category: Vec<(Category, usize)> = Category::ALL
      .into_iter()
      .map(|category| {
        let count = counts.iter().find(|(name, _)| name == category.as_str()).map_or(0, |(_, n)| *n);
        (category, count)
      })
      .collect();
    let total = counts.iter().map(|(_, n)| n).sum();

    let missing_embeddings = match embedding_model {
      Some(model) => self.conn.query_row(
        "SELECT COUNT(*) FROM memories WHERE archived = 0 AND (embedding IS NULL OR embedding_model IS NOT ?1)",
        [model],
        |row| row.get::<_, i64>(0),
      )? as usize,
      None => 0,
    };
    let archived =
      self.conn.query_row("SELECT COUNT(*) FROM memories WHERE archived = 1", [], |row| row.get::<_, i64>(0))? as usize;

    Ok(MemoryStats { total, by_category, missing_embeddings, archived })
  }

  /// 读取所有未归档的记忆，只附带与查询同一模型生成的向量
  fn candidates(&self, query_model: Option<&str>) -> rusqlite::Result<Vec<Candidate>> {
    let mut statement = self
      .conn
      .prepare(&format!("SELECT {MEMORY_COLUMNS}, embedding FROM memories WHERE archived = 0"))?;
    let candidates = statement
      .query_map([], |row| {
        let memory = read_memory(row)?;
        let blob: Option<Vec<u8>> = row.get("embedding")?;
        let embedding = match (blob, query_model) {
          (Some(blob), Some(model)) if memory.embedding_model.as_deref() == Some(model) => decode_embedding(&blob),
          _ => None,
        };
        Ok(Candidate { memory, embedding })
      })?
      // 跳过无法识别的类别等损坏数据，而不是让整个检索失败
      .filter_map(Result::ok)
      .collect();
    Ok(candidates)
  }

  /// 检索与查询最相关的记忆，并记录这些记忆被访问
  pub fn search(&self, request: &SearchRequest, now: i64) -> rusqlite::Result<SearchResult> {
    let query_model = request.embedding.as_ref().and(request.embedding_model.as_deref());
    let ranked = rank(
      self.candidates(query_model)?,
      &RankOptions {
        query: &request.query,
        query_embedding: request.embedding.as_deref(),
        limit: request.limit,
        core_limit: request.core_limit,
        weights: request.weights,
        now,
      },
    );

    if request.touch && !ranked.memories.is_empty() {
      let ids: Vec<i64> = ranked.memories.iter().map(|m| m.memory.id).collect();
      let placeholders = vec!["?"; ids.len()].join(", ");
      self.conn.execute(
        &format!(
          "UPDATE memories SET last_accessed_at = {now}, access_count = access_count + 1 WHERE id IN ({placeholders})"
        ),
        params_from_iter(ids),
      )?;
    }

    Ok(SearchResult {
      memories: ranked.memories,
      semantic: ranked.semantic,
      missing_embeddings: ranked.missing_embeddings,
    })
  }

  /// 找出与一段内容最相似的记忆，用于写入前去重（不记录访问）
  pub fn similar(&self, request: &SimilarRequest) -> rusqlite::Result<Vec<SimilarMemory>> {
    let query_model = request.embedding.as_ref().and(request.embedding_model.as_deref());
    Ok(similar(self.candidates(query_model)?, &request.content, request.embedding.as_deref(), request.limit))
  }

  // ===== 写入 =====

  pub fn add(&self, new: NewMemory, change: Change) -> Result<Memory, String> {
    let content = new.content.trim();
    if content.is_empty() {
      return Err("记忆内容不能为空".into());
    }
    let category = new.category.unwrap_or(Category::Episodic);
    let importance = new.importance.unwrap_or(0.5).clamp(0.0, 1.0);
    let (embedding, embedding_model) = match (new.embedding, new.embedding_model) {
      (Some(embedding), Some(model)) if !embedding.is_empty() => (Some(encode_embedding(&embedding)), Some(model)),
      _ => (None, None),
    };

    let id = (|| {
      let transaction = self.conn.unchecked_transaction()?;
      transaction.execute(
        "INSERT INTO memories (category, content, importance, occurred_at, created_at, updated_at, source, embedding, embedding_model)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8)",
        params![category.as_str(), content, importance, new.occurred_at, change.now, new.source, embedding, embedding_model],
      )?;
      let id = transaction.last_insert_rowid();
      log_event(&transaction, id, EventAction::Add, category, content, None, None, change)?;
      transaction.commit()?;
      Ok::<_, rusqlite::Error>(id)
    })()
    .map_err(|e| e.to_string())?;

    self.get(id).map_err(|e| e.to_string())?.ok_or_else(|| "写入记忆失败".into())
  }

  /// 修改记忆。修改了内容但没有提供新向量时清除旧向量（之后由前端补全）
  pub fn update(&self, id: i64, patch: MemoryPatch, change: Change) -> Result<Memory, String> {
    let current = self.get(id).map_err(|e| e.to_string())?.ok_or("记忆不存在或已被归档")?;

    let content = patch
      .content
      .as_deref()
      .map(str::trim)
      .filter(|content| !content.is_empty())
      .unwrap_or(&current.content)
      .to_string();
    let content_changed = content != current.content;
    let category = patch.category.unwrap_or(current.category);
    let importance = patch.importance.map_or(current.importance, |v| v.clamp(0.0, 1.0));
    let occurred_at = patch.occurred_at.or(current.occurred_at);
    let pinned = patch.pinned.unwrap_or(current.pinned);

    (|| {
      let transaction = self.conn.unchecked_transaction()?;
      transaction.execute(
        "UPDATE memories SET content = ?1, category = ?2, importance = ?3, occurred_at = ?4, pinned = ?5, updated_at = ?6
         WHERE id = ?7",
        params![content, category.as_str(), importance, occurred_at, pinned, change.now, id],
      )?;
      match (patch.embedding, patch.embedding_model) {
        (Some(embedding), Some(model)) if !embedding.is_empty() => {
          transaction.execute(
            "UPDATE memories SET embedding = ?1, embedding_model = ?2 WHERE id = ?3",
            params![encode_embedding(&embedding), model, id],
          )?;
        }
        _ if content_changed => {
          transaction.execute("UPDATE memories SET embedding = NULL, embedding_model = NULL WHERE id = ?1", [id])?;
        }
        _ => {}
      }
      let previous = content_changed.then_some(current.content.as_str());
      log_event(&transaction, id, EventAction::Update, category, &content, previous, Some(&current), change)?;
      transaction.commit()
    })()
    .map_err(|e| e.to_string())?;

    self.get(id).map_err(|e| e.to_string())?.ok_or_else(|| "修改记忆失败".into())
  }

  /// 用户再次提到已有的记忆：刷新更新时间，重要程度只升不降
  pub fn reinforce(&self, id: i64, importance: Option<f64>, change: Change) -> Result<Memory, String> {
    let current = self.get(id).map_err(|e| e.to_string())?.ok_or("记忆不存在或已被归档")?;
    let importance = importance.map_or(current.importance, |v| current.importance.max(v.clamp(0.0, 1.0)));

    (|| {
      let transaction = self.conn.unchecked_transaction()?;
      transaction.execute(
        "UPDATE memories SET importance = ?1, updated_at = ?2 WHERE id = ?3",
        params![importance, change.now, id],
      )?;
      log_event(&transaction, id, EventAction::Reinforce, current.category, &current.content, None, Some(&current), change)?;
      transaction.commit()
    })()
    .map_err(|e| e.to_string())?;

    self.get(id).map_err(|e| e.to_string())?.ok_or_else(|| "修改记忆失败".into())
  }

  /// 归档记忆（如已被合并到其他记忆中、被遗忘）：不再参与检索，但保留在数据库中，可以恢复
  pub fn archive(&self, ids: &[i64], change: Change) -> rusqlite::Result<usize> {
    let transaction = self.conn.unchecked_transaction()?;
    let mut archived = 0;
    for &id in ids {
      let Some(memory) = self.get(id)? else { continue };
      transaction.execute("UPDATE memories SET archived = 1, updated_at = ?1 WHERE id = ?2", params![change.now, id])?;
      log_event(&transaction, id, EventAction::Archive, memory.category, &memory.content, None, Some(&memory), change)?;
      archived += 1;
    }
    transaction.commit()?;
    Ok(archived)
  }

  /// 从归档中恢复记忆，并刷新更新时间（避免刚恢复就又被遗忘）
  pub fn restore(&self, ids: &[i64], change: Change) -> rusqlite::Result<usize> {
    let transaction = self.conn.unchecked_transaction()?;
    let mut restored = 0;
    for &id in ids {
      let Some(memory) = self.get_any(id)?.filter(|memory| memory.archived) else { continue };
      transaction.execute("UPDATE memories SET archived = 0, updated_at = ?1 WHERE id = ?2", params![change.now, id])?;
      log_event(&transaction, id, EventAction::Restore, memory.category, &memory.content, None, Some(&memory), change)?;
      restored += 1;
    }
    transaction.commit()?;
    Ok(restored)
  }

  /// 永久删除记忆（包括已归档的）
  pub fn delete(&self, id: i64, change: Change) -> rusqlite::Result<bool> {
    let Some(memory) = self.get_any(id)? else { return Ok(false) };

    let transaction = self.conn.unchecked_transaction()?;
    transaction.execute("DELETE FROM memories WHERE id = ?1", [id])?;
    log_event(&transaction, id, EventAction::Delete, memory.category, &memory.content, None, Some(&memory), change)?;
    transaction.commit()?;
    Ok(true)
  }

  // ===== 撤销 =====

  /// 撤销一批变动（batch_id）或一条变动（event_id），按从新到旧的顺序还原。
  /// 如果其中某条记忆之后又有其他变动，需要先撤销之后的变动
  pub fn undo(&self, batch_id: Option<&str>, event_id: Option<i64>, now: i64) -> Result<usize, String> {
    let events = self.undo_targets(batch_id, event_id).map_err(|e| e.to_string())?;
    if events.is_empty() {
      return Err("没有可以撤销的变动".into());
    }

    let ids: HashSet<i64> = events.iter().map(|event| event.id).collect();
    for event in &events {
      let mut statement = self
        .conn
        .prepare("SELECT id, content FROM memory_events WHERE memory_id = ?1 AND id > ?2 AND undone_at IS NULL ORDER BY id")
        .map_err(|e| e.to_string())?;
      let later: Vec<(i64, String)> = statement
        .query_map(params![event.memory_id, event.id], |row| Ok((row.get(0)?, row.get(1)?)))
        .and_then(Iterator::collect)
        .map_err(|e| e.to_string())?;
      if let Some((_, content)) = later.iter().find(|(id, _)| !ids.contains(id)) {
        return Err(format!("「{}」之后又有新的变动，请先撤销之后的变动", truncate(content, 30)));
      }
    }

    let transaction = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for event in &events {
      self.revert(&transaction, event)?;
      transaction
        .execute("UPDATE memory_events SET undone_at = ?1 WHERE id = ?2", params![now, event.id])
        .map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(events.len())
  }

  fn undo_targets(&self, batch_id: Option<&str>, event_id: Option<i64>) -> rusqlite::Result<Vec<StoredEvent>> {
    let (filter, value): (&str, rusqlite::types::Value) = match (batch_id, event_id) {
      (Some(batch), _) => ("batch_id = ?1", batch.to_string().into()),
      (None, Some(id)) => ("id = ?1", id.into()),
      (None, None) => return Ok(Vec::new()),
    };
    let mut statement = self.conn.prepare(&format!(
      "SELECT id, memory_id, action, content, previous, snapshot FROM memory_events
       WHERE {filter} AND undone_at IS NULL ORDER BY id DESC"
    ))?;
    let rows = statement.query_map([value], |row| {
      let action: String = row.get(2)?;
      let snapshot: Option<String> = row.get(5)?;
      Ok(StoredEvent {
        id: row.get(0)?,
        memory_id: row.get(1)?,
        action: EventAction::parse(&action).ok_or_else(|| conversion_error(2, format!("未知的变动类型：{action}")))?,
        content: row.get(3)?,
        previous: row.get(4)?,
        snapshot: snapshot.and_then(|json| serde_json::from_str(&json).ok()),
      })
    })?;
    rows.collect()
  }

  /// 把一条变动还原到变动前的状态
  fn revert(&self, transaction: &Connection, event: &StoredEvent) -> Result<(), String> {
    let id = event.memory_id;
    let result = match event.action {
      // 撤销新增：删除这条记忆
      EventAction::Add => transaction.execute("DELETE FROM memories WHERE id = ?1", [id]).map(|_| ()),
      // 撤销删除：按原来的 id 重新插入（向量之后由前端补全）
      EventAction::Delete => {
        let snapshot = event.snapshot.as_ref().ok_or("较早的删除记录缺少删除前的内容，无法撤销")?;
        if self.get_any(id).map_err(|e| e.to_string())?.is_some() {
          return Err(format!("「{}」已经存在，无需恢复", truncate(&event.content, 30)));
        }
        transaction
          .execute(
            "INSERT INTO memories (id, category, content, importance, occurred_at, created_at, updated_at,
               last_accessed_at, access_count, source, archived, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
              id,
              snapshot.category.as_str(),
              snapshot.content,
              snapshot.importance,
              snapshot.occurred_at,
              snapshot.created_at,
              snapshot.updated_at,
              snapshot.last_accessed_at,
              snapshot.access_count,
              snapshot.source,
              snapshot.archived,
              snapshot.pinned,
            ],
          )
          .map(|_| ())
      }
      // 其余变动：恢复变动前的内容与状态（访问统计保持不变）
      _ => {
        let current = self
          .get_any(id)
          .map_err(|e| e.to_string())?
          .ok_or_else(|| format!("「{}」已被删除，无法撤销", truncate(&event.content, 30)))?;
        match (&event.snapshot, event.action) {
          (Some(snapshot), _) => transaction
            .execute(
              "UPDATE memories SET category = ?1, content = ?2, importance = ?3, occurred_at = ?4, updated_at = ?5,
                 archived = ?6, pinned = ?7 WHERE id = ?8",
              params![
                snapshot.category.as_str(),
                snapshot.content,
                snapshot.importance,
                snapshot.occurred_at,
                snapshot.updated_at,
                snapshot.archived,
                snapshot.pinned,
                id,
              ],
            )
            .and_then(|_| clear_embedding_if_changed(transaction, id, &current.content, &snapshot.content)),
          // 第 3 版之前的记录没有快照：修改只能恢复内容，归档可以直接恢复
          (None, EventAction::Update) if event.previous.is_some() => {
            let previous = event.previous.as_deref().unwrap_or_default();
            transaction
              .execute("UPDATE memories SET content = ?1 WHERE id = ?2", params![previous, id])
              .and_then(|_| clear_embedding_if_changed(transaction, id, &current.content, previous))
          }
          (None, EventAction::Archive) => {
            transaction.execute("UPDATE memories SET archived = 0 WHERE id = ?1", [id]).map(|_| ())
          }
          (None, _) => return Err("较早的记录缺少变动前的状态，无法撤销".into()),
        }
      }
    };
    result.map_err(|e| e.to_string())
  }

  /// 最近的变动记录，从新到旧，并标出现在能否撤销
  pub fn events(&self, limit: usize) -> rusqlite::Result<Vec<MemoryEvent>> {
    let mut statement = self.conn.prepare(
      "SELECT e.id, e.memory_id, e.action, e.category, e.content, e.previous, e.source, e.batch_id, e.created_at,
         e.undone_at, e.snapshot IS NOT NULL,
         EXISTS (
           SELECT 1 FROM memory_events l
           WHERE l.memory_id = e.memory_id AND l.id > e.id AND l.undone_at IS NULL
             AND (e.batch_id IS NULL OR l.batch_id IS NOT e.batch_id)
         )
       FROM memory_events e ORDER BY e.id DESC LIMIT ?1",
    )?;
    let rows = statement.query_map([limit as i64], |row| {
      let action: String = row.get(2)?;
      let category: String = row.get(3)?;
      let action = EventAction::parse(&action).ok_or_else(|| conversion_error(2, format!("未知的变动类型：{action}")))?;
      let previous: Option<String> = row.get(5)?;
      let undone_at: Option<i64> = row.get(9)?;
      let has_snapshot: bool = row.get(10)?;
      let blocked: bool = row.get(11)?;
      // 撤销需要的信息是否齐全（第 3 版之前的记录没有快照）
      let restorable = match action {
        EventAction::Add | EventAction::Archive => true,
        EventAction::Update => has_snapshot || previous.is_some(),
        _ => has_snapshot,
      };
      Ok(MemoryEvent {
        id: row.get(0)?,
        memory_id: row.get(1)?,
        action,
        category: Category::parse(&category).ok_or_else(|| conversion_error(3, format!("未知的记忆类别：{category}")))?,
        content: row.get(4)?,
        previous,
        source: row.get(6)?,
        batch_id: row.get(7)?,
        created_at: row.get(8)?,
        undone_at,
        undoable: undone_at.is_none() && restorable && !blocked,
      })
    })?;
    // 跳过无法识别的记录
    Ok(rows.filter_map(Result::ok).collect())
  }

  /// 某个时间之后由对话或手动产生的新增与修改数量（不含整理、遗忘本身），用于判断是否需要整理
  pub fn changes_since(&self, since: i64) -> rusqlite::Result<usize> {
    self
      .conn
      .query_row(
        "SELECT COUNT(*) FROM memory_events
         WHERE created_at > ?1 AND undone_at IS NULL AND action IN ('add', 'update')
           AND (source IS NULL OR source NOT IN ('consolidate', 'forget'))",
        [since],
        |row| row.get::<_, i64>(0),
      )
      .map(|count| count as usize)
  }

  // ===== 整理与遗忘 =====

  /// 按遗忘曲线找出应该遗忘的记忆（按记忆强度从低到高）
  pub fn forget_candidates(&self, options: &ForgetOptions, now: i64) -> rusqlite::Result<Vec<ListedMemory>> {
    let mut statement = self.conn.prepare(&format!("SELECT {MEMORY_COLUMNS} FROM memories WHERE archived = 0"))?;
    let mut candidates: Vec<ListedMemory> = statement
      .query_map([], read_memory)?
      .filter_map(Result::ok)
      .filter(|memory| should_forget(memory, now, options))
      .map(|memory| ListedMemory { retention: retention(&memory, now), memory })
      .collect();
    candidates.sort_by(|a, b| a.retention.total_cmp(&b.retention));
    Ok(candidates)
  }

  /// 遗忘：归档记忆强度过低的记忆，返回被遗忘的记忆
  pub fn forget(&self, options: &ForgetOptions, change: Change) -> rusqlite::Result<Vec<ListedMemory>> {
    let candidates = self.forget_candidates(options, change.now)?;
    let ids: Vec<i64> = candidates.iter().map(|c| c.memory.id).collect();
    self.archive(&ids, change)?;
    Ok(candidates)
  }

  /// 把记忆分成交给 LLM 整理的若干组
  pub fn consolidation_groups(&self, embedding_model: Option<&str>, max_group_size: usize) -> rusqlite::Result<Vec<Vec<Memory>>> {
    Ok(consolidation_groups(self.candidates(embedding_model)?, max_group_size))
  }

  // ===== 向量 =====

  /// 列出还没有指定模型向量的记忆，用于补全向量
  pub fn pending_embeddings(&self, model: &str, limit: usize) -> rusqlite::Result<Vec<PendingEmbedding>> {
    let mut statement = self.conn.prepare(
      "SELECT id, content FROM memories
       WHERE archived = 0 AND (embedding IS NULL OR embedding_model IS NOT ?1)
       ORDER BY id LIMIT ?2",
    )?;
    let rows = statement.query_map(params![model, limit as i64], |row| {
      Ok(PendingEmbedding { id: row.get(0)?, content: row.get(1)? })
    })?;
    rows.collect()
  }

  pub fn set_embeddings(&mut self, model: &str, items: &[EmbeddingItem]) -> rusqlite::Result<usize> {
    let transaction = self.conn.transaction()?;
    let mut updated = 0;
    {
      let mut statement =
        transaction.prepare("UPDATE memories SET embedding = ?1, embedding_model = ?2 WHERE id = ?3")?;
      for item in items.iter().filter(|item| !item.embedding.is_empty()) {
        updated += statement.execute(params![encode_embedding(&item.embedding), model, item.id])?;
      }
    }
    transaction.commit()?;
    Ok(updated)
  }
}

/// 记录一次记忆变动（附带变动前的状态，用于撤销），并只保留最近的 MAX_EVENTS 条
#[allow(clippy::too_many_arguments)]
fn log_event(
  conn: &Connection,
  memory_id: i64,
  action: EventAction,
  category: Category,
  content: &str,
  previous: Option<&str>,
  before: Option<&Memory>,
  change: Change,
) -> rusqlite::Result<()> {
  let snapshot = before
    .map(|memory| serde_json::to_string(&MemorySnapshot::from(memory)))
    .transpose()
    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
  conn.execute(
    "INSERT INTO memory_events (memory_id, action, category, content, previous, source, batch_id, snapshot, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    params![memory_id, action.as_str(), category.as_str(), content, previous, change.source, change.batch, snapshot, change.now],
  )?;
  conn.execute(
    "DELETE FROM memory_events WHERE id <= (SELECT MAX(id) FROM memory_events) - ?1",
    [MAX_EVENTS],
  )?;
  Ok(())
}

/// 内容变了，向量也就不再对应，清除后由前端补全
fn clear_embedding_if_changed(conn: &Connection, id: i64, current: &str, restored: &str) -> rusqlite::Result<()> {
  if current != restored {
    conn.execute("UPDATE memories SET embedding = NULL, embedding_model = NULL WHERE id = ?1", [id])?;
  }
  Ok(())
}

fn truncate(text: &str, max_chars: usize) -> String {
  if text.chars().count() <= max_chars {
    text.to_string()
  } else {
    format!("{}…", text.chars().take(max_chars).collect::<String>())
  }
}

fn conversion_error(column: usize, message: String) -> rusqlite::Error {
  rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, message.into())
}

fn read_memory(row: &Row) -> rusqlite::Result<Memory> {
  let category: String = row.get(1)?;
  Ok(Memory {
    id: row.get(0)?,
    category: Category::parse(&category).ok_or_else(|| conversion_error(1, format!("未知的记忆类别：{category}")))?,
    content: row.get(2)?,
    importance: row.get(3)?,
    occurred_at: row.get(4)?,
    created_at: row.get(5)?,
    updated_at: row.get(6)?,
    last_accessed_at: row.get(7)?,
    access_count: row.get(8)?,
    source: row.get(9)?,
    embedding_model: row.get(10)?,
    archived: row.get(11)?,
    pinned: row.get(12)?,
  })
}

/// 向量以小端序 f32 数组的形式存为 BLOB
fn encode_embedding(embedding: &[f32]) -> Vec<u8> {
  embedding.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn decode_embedding(blob: &[u8]) -> Option<Vec<f32>> {
  if blob.is_empty() || blob.len() % 4 != 0 {
    return None;
  }
  Some(blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

#[cfg(test)]
mod tests;
