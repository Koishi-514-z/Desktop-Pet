//! 长期记忆：以 SQLite 存储分类的记忆，并按语义相关性、重要程度、新近程度综合排名检索。
//!
//! 数据库文件位于应用数据目录下的 memory.db。向量由前端调用 embedding 模型生成后传入，
//! Rust 端负责存储与比较（记忆数量通常在数千条以内，逐条计算余弦相似度即可）。
//! 所有变动都会记录在 memory_events 表中，可以按批撤销。

mod db;
mod maintain;
mod model;
mod rank;

use std::{
  path::PathBuf,
  sync::Mutex,
  time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager};

use db::{Change, MemoryDb};
use model::{
  Category, EmbeddingItem, ForgetOptions, ListedMemory, Memory, MemoryEvent, MemoryPatch, MemoryStats, NewMemory,
  PendingEmbedding, SearchRequest, SearchResult, SimilarMemory, SimilarRequest,
};

const DATABASE_FILE: &str = "memory.db";

/// 记忆数据库。打开失败时保存错误信息，所有命令都会返回该错误
pub struct MemoryState {
  db: Mutex<Result<MemoryDb, String>>,
  path: Option<PathBuf>,
}

impl MemoryState {
  pub fn open(app: &AppHandle) -> Self {
    let path = app.path().app_data_dir().map(|dir| dir.join(DATABASE_FILE));
    let db = match &path {
      Ok(path) => path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .map_err(|e| e.to_string())
        .and_then(|_| MemoryDb::open(path).map_err(|e| e.to_string()))
        .map_err(|e| format!("无法打开记忆数据库 {}：{e}", path.display())),
      Err(e) => Err(format!("无法确定应用数据目录：{e}")),
    };
    if let Err(error) = &db {
      log::error!("{error}");
    }
    Self { db: Mutex::new(db), path: path.ok() }
  }
}

fn now_millis() -> i64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// 在后台线程中访问数据库，避免阻塞界面
async fn with_db<T, F>(app: AppHandle, f: F) -> Result<T, String>
where
  T: Send + 'static,
  F: FnOnce(&mut MemoryDb) -> Result<T, String> + Send + 'static,
{
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<MemoryState>();
    let mut guard = state.db.lock().map_err(|e| e.to_string())?;
    let db = guard.as_mut().map_err(|e| e.clone())?;
    f(db)
  })
  .await
  .map_err(|e| e.to_string())?
}

fn parse_category(category: Option<String>) -> Result<Option<Category>, String> {
  category
    .map(|value| Category::parse(&value).ok_or_else(|| format!("未知的记忆类别：{value}")))
    .transpose()
}

// ===== 检索 =====

/// 检索与查询最相关的记忆（核心档案在前，其余按综合得分排序）
#[tauri::command]
pub async fn memory_search(app: AppHandle, request: SearchRequest) -> Result<SearchResult, String> {
  with_db(app, move |db| {
    let now = request.now.unwrap_or_else(now_millis);
    db.search(&request, now).map_err(|e| e.to_string())
  })
  .await
}

/// 找出与一段内容最相似的已有记忆，用于写入前去重
#[tauri::command]
pub async fn memory_similar(app: AppHandle, request: SimilarRequest) -> Result<Vec<SimilarMemory>, String> {
  with_db(app, move |db| db.similar(&request).map_err(|e| e.to_string())).await
}

/// 按 id 获取未归档的记忆
#[tauri::command]
pub async fn memory_get(app: AppHandle, ids: Vec<i64>) -> Result<Vec<Memory>, String> {
  with_db(app, move |db| db.get_many(&ids).map_err(|e| e.to_string())).await
}

/// 按更新时间从新到旧列出记忆（archived 为 true 时列出已归档的），附带当前的记忆强度
#[tauri::command]
pub async fn memory_list(
  app: AppHandle,
  category: Option<String>,
  archived: Option<bool>,
  limit: Option<usize>,
  offset: Option<usize>,
) -> Result<Vec<ListedMemory>, String> {
  let category = parse_category(category)?;
  with_db(app, move |db| {
    db.list(category, archived.unwrap_or(false), limit.unwrap_or(50), offset.unwrap_or(0), now_millis())
      .map_err(|e| e.to_string())
  })
  .await
}

/// 统计各类别的记忆数量；传入 embedding_model 时同时统计缺少该模型向量的记忆数量
#[tauri::command]
pub async fn memory_stats(app: AppHandle, embedding_model: Option<String>) -> Result<MemoryStats, String> {
  with_db(app, move |db| db.stats(embedding_model.as_deref()).map_err(|e| e.to_string())).await
}

// ===== 写入 =====
// source 为变动来源（如 chat:会话 id、manual、consolidate、forget），batch 为批次（同一批的变动一起撤销）

#[tauri::command]
pub async fn memory_add(
  app: AppHandle,
  memory: NewMemory,
  source: Option<String>,
  batch: Option<String>,
) -> Result<Memory, String> {
  with_db(app, move |db| {
    let source = source.or_else(|| memory.source.clone());
    db.add(memory, Change { source: source.as_deref(), batch: batch.as_deref(), now: now_millis() })
  })
  .await
}

/// 修改记忆（合并、修正、编辑、固定），省略的字段保持不变
#[tauri::command]
pub async fn memory_update(
  app: AppHandle,
  id: i64,
  patch: MemoryPatch,
  source: Option<String>,
  batch: Option<String>,
) -> Result<Memory, String> {
  with_db(app, move |db| {
    db.update(id, patch, Change { source: source.as_deref(), batch: batch.as_deref(), now: now_millis() })
  })
  .await
}

/// 用户再次提到已有的记忆：刷新更新时间，重要程度只升不降
#[tauri::command]
pub async fn memory_reinforce(
  app: AppHandle,
  id: i64,
  importance: Option<f64>,
  source: Option<String>,
  batch: Option<String>,
) -> Result<Memory, String> {
  with_db(app, move |db| {
    db.reinforce(id, importance, Change { source: source.as_deref(), batch: batch.as_deref(), now: now_millis() })
  })
  .await
}

/// 归档记忆（如已被合并到其他记忆中），返回实际归档的数量
#[tauri::command]
pub async fn memory_archive(
  app: AppHandle,
  ids: Vec<i64>,
  source: Option<String>,
  batch: Option<String>,
) -> Result<usize, String> {
  with_db(app, move |db| {
    db.archive(&ids, Change { source: source.as_deref(), batch: batch.as_deref(), now: now_millis() })
      .map_err(|e| e.to_string())
  })
  .await
}

/// 从归档中恢复记忆，返回实际恢复的数量
#[tauri::command]
pub async fn memory_restore(
  app: AppHandle,
  ids: Vec<i64>,
  source: Option<String>,
  batch: Option<String>,
) -> Result<usize, String> {
  with_db(app, move |db| {
    db.restore(&ids, Change { source: source.as_deref(), batch: batch.as_deref(), now: now_millis() })
      .map_err(|e| e.to_string())
  })
  .await
}

/// 永久删除记忆
#[tauri::command]
pub async fn memory_delete(
  app: AppHandle,
  id: i64,
  source: Option<String>,
  batch: Option<String>,
) -> Result<bool, String> {
  with_db(app, move |db| {
    db.delete(id, Change { source: source.as_deref(), batch: batch.as_deref(), now: now_millis() })
      .map_err(|e| e.to_string())
  })
  .await
}

// ===== 变动记录与撤销 =====

/// 最近的记忆变动记录，从新到旧
#[tauri::command]
pub async fn memory_events(app: AppHandle, limit: Option<usize>) -> Result<Vec<MemoryEvent>, String> {
  with_db(app, move |db| db.events(limit.unwrap_or(50)).map_err(|e| e.to_string())).await
}

/// 撤销一批变动（batch_id）或一条变动（event_id），返回撤销的变动数量
#[tauri::command]
pub async fn memory_undo(app: AppHandle, batch_id: Option<String>, event_id: Option<i64>) -> Result<usize, String> {
  with_db(app, move |db| db.undo(batch_id.as_deref(), event_id, now_millis())).await
}

/// 某个时间之后由对话或手动产生的新增与修改数量，用于判断是否需要整理
#[tauri::command]
pub async fn memory_changes_since(app: AppHandle, since: i64) -> Result<usize, String> {
  with_db(app, move |db| db.changes_since(since).map_err(|e| e.to_string())).await
}

// ===== 整理与遗忘 =====

/// 预览按遗忘曲线应该遗忘的记忆
#[tauri::command]
pub async fn memory_forget_preview(app: AppHandle, options: Option<ForgetOptions>) -> Result<Vec<ListedMemory>, String> {
  with_db(app, move |db| db.forget_candidates(&options.unwrap_or_default(), now_millis()).map_err(|e| e.to_string())).await
}

/// 遗忘：归档记忆强度过低的记忆，返回被遗忘的记忆
#[tauri::command]
pub async fn memory_forget(
  app: AppHandle,
  options: Option<ForgetOptions>,
  source: Option<String>,
  batch: Option<String>,
) -> Result<Vec<ListedMemory>, String> {
  with_db(app, move |db| {
    let change = Change { source: source.as_deref(), batch: batch.as_deref(), now: now_millis() };
    db.forget(&options.unwrap_or_default(), change).map_err(|e| e.to_string())
  })
  .await
}

/// 把记忆分成交给 LLM 整理的若干组（同一类别、相似的记忆尽量在同一组）
#[tauri::command]
pub async fn memory_consolidation_groups(
  app: AppHandle,
  embedding_model: Option<String>,
  max_group_size: Option<usize>,
) -> Result<Vec<Vec<Memory>>, String> {
  with_db(app, move |db| {
    db.consolidation_groups(embedding_model.as_deref(), max_group_size.unwrap_or(40)).map_err(|e| e.to_string())
  })
  .await
}

// ===== 向量 =====

#[tauri::command]
pub async fn memory_pending_embeddings(app: AppHandle, model: String, limit: usize) -> Result<Vec<PendingEmbedding>, String> {
  with_db(app, move |db| db.pending_embeddings(&model, limit).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn memory_set_embeddings(app: AppHandle, model: String, items: Vec<EmbeddingItem>) -> Result<usize, String> {
  with_db(app, move |db| db.set_embeddings(&model, &items).map_err(|e| e.to_string())).await
}

/// 数据库文件路径，供设置界面展示
#[tauri::command]
pub fn memory_database_path(app: AppHandle) -> Option<String> {
  app.state::<MemoryState>().path.as_ref().map(|path| path.display().to_string())
}
