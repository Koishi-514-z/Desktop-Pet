use super::*;
use crate::memory::model::Weights;

const NOW: i64 = 1_800_000_000_000;
const DAY: i64 = 86_400_000;

fn at(now: i64) -> Change<'static> {
  Change { source: None, batch: None, now }
}

fn batch(batch: &'static str, now: i64) -> Change<'static> {
  Change { source: Some("chat:s1"), batch: Some(batch), now }
}

fn new(category: Category, content: &str, importance: f64, embedding: Option<Vec<f32>>) -> NewMemory {
  NewMemory {
    category: Some(category),
    content: content.into(),
    importance: Some(importance),
    embedding_model: embedding.as_ref().map(|_| "model-a".into()),
    embedding,
    ..Default::default()
  }
}

fn search(query: &str, embedding: Option<Vec<f32>>, model: &str) -> SearchRequest {
  SearchRequest {
    query: query.into(),
    embedding,
    embedding_model: Some(model.into()),
    limit: 6,
    core_limit: 5,
    weights: Weights::default(),
    now: None,
    touch: true,
  }
}

fn actions(db: &MemoryDb) -> Vec<(i64, EventAction)> {
  db.events(100).unwrap().into_iter().rev().map(|event| (event.memory_id, event.action)).collect()
}

fn contents(db: &MemoryDb) -> Vec<String> {
  let mut contents: Vec<String> = db.list(None, false, 100, 0, NOW).unwrap().into_iter().map(|m| m.memory.content).collect();
  contents.sort();
  contents
}

// ===== 基本读写 =====

#[test]
fn adds_lists_and_deletes() {
  let db = MemoryDb::open_in_memory().unwrap();
  let a = db.add(new(Category::Profile, "  用户叫小明  ", 0.9, None), at(NOW)).unwrap();
  let b = db.add(new(Category::Episodic, "用户今天面试", 1.5, Some(vec![1.0, 0.0])), at(NOW + 1)).unwrap();

  assert_eq!(a.content, "用户叫小明");
  assert_eq!(b.importance, 1.0, "重要程度会被限制在 0 ~ 1");
  assert_eq!(b.embedding_model.as_deref(), Some("model-a"));
  assert!(db.add(new(Category::Episodic, "   ", 0.5, None), at(NOW)).is_err());

  let all = db.list(None, false, 10, 0, NOW).unwrap();
  assert_eq!(all.iter().map(|m| m.memory.id).collect::<Vec<_>>(), vec![b.id, a.id]);
  assert_eq!(db.list(Some(Category::Profile), false, 10, 0, NOW).unwrap().len(), 1);

  let stats = db.stats(Some("model-a")).unwrap();
  assert_eq!(stats.total, 2);
  assert_eq!(stats.missing_embeddings, 1);

  assert!(db.delete(a.id, at(NOW)).unwrap());
  assert!(!db.delete(a.id, at(NOW)).unwrap());
  assert_eq!(db.stats(None).unwrap().total, 1);
  assert_eq!(actions(&db), vec![(a.id, EventAction::Add), (b.id, EventAction::Add), (a.id, EventAction::Delete)]);
}

#[test]
fn updates_and_records_previous_content() {
  let db = MemoryDb::open_in_memory().unwrap();
  let memory = db.add(new(Category::Profile, "用户住在杭州", 0.7, Some(vec![1.0, 0.0])), at(NOW)).unwrap();

  // 只改重要程度与固定：保留向量
  let patch = MemoryPatch { importance: Some(0.8), pinned: Some(true), ..Default::default() };
  let updated = db.update(memory.id, patch, at(NOW + 1)).unwrap();
  assert_eq!(updated.importance, 0.8);
  assert!(updated.pinned);
  assert_eq!(updated.embedding_model.as_deref(), Some("model-a"));

  // 改了内容但没有新向量：清除旧向量，等待补全
  let patch = MemoryPatch { content: Some("用户搬到了上海，以前住在杭州".into()), ..Default::default() };
  let updated = db.update(memory.id, patch, Change { source: Some("auto"), batch: None, now: NOW + 2 }).unwrap();
  assert_eq!(updated.content, "用户搬到了上海，以前住在杭州");
  assert_eq!(updated.embedding_model, None);
  assert_eq!(updated.updated_at, NOW + 2);

  let event = &db.events(1).unwrap()[0];
  assert_eq!(event.action, EventAction::Update);
  assert_eq!(event.previous.as_deref(), Some("用户住在杭州"));
  assert_eq!(event.source.as_deref(), Some("auto"));

  // 带新向量修改：直接替换
  let patch = MemoryPatch {
    content: Some("用户住在上海".into()),
    embedding: Some(vec![0.0, 1.0]),
    embedding_model: Some("model-a".into()),
    ..Default::default()
  };
  assert_eq!(db.update(memory.id, patch, at(NOW + 3)).unwrap().embedding_model.as_deref(), Some("model-a"));
}

#[test]
fn reinforces_without_lowering_importance() {
  let db = MemoryDb::open_in_memory().unwrap();
  let memory = db.add(new(Category::Preference, "用户喜欢猫", 0.6, None), at(NOW)).unwrap();

  assert_eq!(db.reinforce(memory.id, Some(0.3), at(NOW + 1)).unwrap().importance, 0.6);
  let reinforced = db.reinforce(memory.id, Some(0.8), at(NOW + 2)).unwrap();
  assert_eq!(reinforced.importance, 0.8);
  assert_eq!(reinforced.updated_at, NOW + 2);
  assert_eq!(db.events(1).unwrap()[0].action, EventAction::Reinforce);
}

#[test]
fn archives_and_restores_memories() {
  let db = MemoryDb::open_in_memory().unwrap();
  let a = db.add(new(Category::Preference, "用户喜欢喝拿铁咖啡", 0.5, None), at(NOW)).unwrap();
  let b = db.add(new(Category::Preference, "用户爱喝咖啡", 0.5, None), at(NOW)).unwrap();

  assert_eq!(db.archive(&[b.id, 999], at(NOW + 1)).unwrap(), 1);
  // 归档的记忆不再出现在列表、检索与去重中，也不能再修改
  assert_eq!(db.list(None, false, 10, 0, NOW).unwrap().iter().map(|m| m.memory.id).collect::<Vec<_>>(), vec![a.id]);
  assert_eq!(db.list(None, true, 10, 0, NOW).unwrap()[0].memory.id, b.id);
  assert_eq!(db.stats(None).unwrap().archived, 1);
  let request = SimilarRequest { content: "用户爱喝咖啡".into(), embedding: None, embedding_model: None, limit: 5 };
  assert!(db.similar(&request).unwrap().iter().all(|m| m.memory.id != b.id));
  assert!(db.update(b.id, MemoryPatch::default(), at(NOW)).is_err());

  // 恢复后重新参与检索，并刷新更新时间
  assert_eq!(db.restore(&[b.id, a.id], at(NOW + 2)).unwrap(), 1);
  let restored = db.get(b.id).unwrap().unwrap();
  assert_eq!(restored.updated_at, NOW + 2);
  assert_eq!(db.events(1).unwrap()[0].action, EventAction::Restore);

  // 已归档的记忆也可以永久删除
  db.archive(&[b.id], at(NOW + 3)).unwrap();
  assert!(db.delete(b.id, at(NOW + 4)).unwrap());
}

#[test]
fn finds_similar_memories() {
  let db = MemoryDb::open_in_memory().unwrap();
  let hangzhou = db.add(new(Category::Profile, "用户住在杭州", 0.8, Some(vec![1.0, 0.0])), at(NOW)).unwrap();
  db.add(new(Category::Preference, "用户喜欢猫", 0.5, Some(vec![0.0, 1.0])), at(NOW)).unwrap();

  let request = SimilarRequest {
    content: "用户搬去了上海".into(),
    embedding: Some(vec![0.9, 0.2]),
    embedding_model: Some("model-a".into()),
    limit: 1,
  };
  let found = db.similar(&request).unwrap();
  assert_eq!(found.len(), 1);
  assert_eq!(found[0].memory.id, hangzhou.id);
  assert!(found[0].similarity.unwrap() > 0.9);
  // 去重查询不记录访问
  assert_eq!(db.get(hangzhou.id).unwrap().unwrap().access_count, 0);
}

#[test]
fn searches_with_embeddings_and_records_access() {
  let db = MemoryDb::open_in_memory().unwrap();
  let coffee = db.add(new(Category::Preference, "用户喜欢喝拿铁", 0.5, Some(vec![1.0, 0.0])), at(NOW)).unwrap();
  db.add(new(Category::Episodic, "用户上周去爬山", 0.5, Some(vec![0.0, 1.0])), at(NOW)).unwrap();

  let result = db.search(&search("来杯咖啡", Some(vec![0.9, 0.1]), "model-a"), NOW).unwrap();
  assert!(result.semantic);
  assert_eq!(result.memories.iter().map(|m| m.memory.id).collect::<Vec<_>>(), vec![coffee.id]);

  let touched = db.get(coffee.id).unwrap().unwrap();
  assert_eq!(touched.access_count, 1);
  assert_eq!(touched.last_accessed_at, Some(NOW));
}

#[test]
fn ignores_embeddings_from_other_models() {
  let db = MemoryDb::open_in_memory().unwrap();
  db.add(new(Category::Preference, "用户喜欢喝拿铁咖啡", 0.5, Some(vec![1.0, 0.0])), at(NOW)).unwrap();

  // 换了向量模型：旧向量不参与比较，退化为关键词匹配，并提示需要补全向量
  let result = db.search(&search("今天又去喝咖啡了", Some(vec![1.0, 0.0]), "model-b"), NOW).unwrap();
  assert!(!result.semantic);
  assert_eq!(result.missing_embeddings, 1);
  assert_eq!(result.memories.len(), 1);
}

#[test]
fn backfills_embeddings() {
  let mut db = MemoryDb::open_in_memory().unwrap();
  let a = db.add(new(Category::Episodic, "a", 0.5, None), at(NOW)).unwrap();
  let b = db.add(new(Category::Episodic, "b", 0.5, Some(vec![1.0])), at(NOW)).unwrap();

  let pending = db.pending_embeddings("model-a", 10).unwrap();
  assert_eq!(pending.iter().map(|p| p.id).collect::<Vec<_>>(), vec![a.id]);
  assert_eq!(db.pending_embeddings("model-b", 10).unwrap().len(), 2);

  let updated = db
    .set_embeddings("model-b", &[EmbeddingItem { id: a.id, embedding: vec![0.5] }, EmbeddingItem { id: b.id, embedding: vec![0.5] }])
    .unwrap();
  assert_eq!(updated, 2);
  assert!(db.pending_embeddings("model-b", 10).unwrap().is_empty());
}

// ===== 撤销 =====

#[test]
fn undoes_a_whole_batch() {
  let db = MemoryDb::open_in_memory().unwrap();
  let hangzhou = db.add(new(Category::Profile, "用户住在杭州", 0.7, Some(vec![1.0, 0.0])), at(NOW)).unwrap();
  let work = db.add(new(Category::Profile, "用户在杭州工作", 0.6, None), at(NOW)).unwrap();

  // 一轮对话后的整理：新增一条、合并一条、归档一条
  let change = batch("turn-1", NOW + DAY);
  let plan = db.add(new(Category::Plan, "用户计划搬家", 0.6, None), change).unwrap();
  let patch = MemoryPatch { content: Some("用户搬去了上海".into()), importance: Some(0.8), ..Default::default() };
  db.update(hangzhou.id, patch, change).unwrap();
  db.archive(&[work.id], change).unwrap();
  assert!(db.events(10).unwrap().iter().filter(|e| e.batch_id.as_deref() == Some("turn-1")).all(|e| e.undoable));

  assert_eq!(db.undo(Some("turn-1"), None, NOW + 2 * DAY).unwrap(), 3);

  // 新增的被删除，合并的恢复原状（内容变了，向量被清除），归档的恢复
  assert!(db.get_any(plan.id).unwrap().is_none());
  let restored = db.get(hangzhou.id).unwrap().unwrap();
  assert_eq!(restored.content, "用户住在杭州");
  assert_eq!(restored.importance, 0.7);
  assert_eq!(restored.updated_at, NOW);
  assert_eq!(restored.embedding_model, None);
  assert!(db.get(work.id).unwrap().is_some());

  // 撤销过的变动不能再次撤销
  assert!(db.events(10).unwrap().iter().filter(|e| e.batch_id.as_deref() == Some("turn-1")).all(|e| e.undone_at.is_some() && !e.undoable));
  assert!(db.undo(Some("turn-1"), None, NOW).is_err());
}

#[test]
fn refuses_to_undo_when_changed_later() {
  let db = MemoryDb::open_in_memory().unwrap();
  let memory = db.add(new(Category::Preference, "用户喜欢猫", 0.5, None), batch("turn-1", NOW)).unwrap();
  let patch = MemoryPatch { content: Some("用户喜欢橘猫".into()), ..Default::default() };
  db.update(memory.id, patch, batch("edit-1", NOW + 1)).unwrap();

  // 之后又被修改过，需要先撤销之后的修改
  let events = db.events(10).unwrap();
  assert!(!events.iter().find(|e| e.batch_id.as_deref() == Some("turn-1")).unwrap().undoable);
  let error = db.undo(Some("turn-1"), None, NOW + 2).unwrap_err();
  assert!(error.contains("之后又有新的变动"), "{error}");

  db.undo(Some("edit-1"), None, NOW + 2).unwrap();
  assert_eq!(db.get(memory.id).unwrap().unwrap().content, "用户喜欢猫");
  db.undo(Some("turn-1"), None, NOW + 3).unwrap();
  assert!(db.get_any(memory.id).unwrap().is_none());
}

#[test]
fn undoes_deletion_and_restoration() {
  let db = MemoryDb::open_in_memory().unwrap();
  let memory = db.add(new(Category::Profile, "用户的生日是 5 月 3 日", 0.9, None), at(NOW)).unwrap();
  db.reinforce(memory.id, Some(0.95), at(NOW + 1)).unwrap();

  db.delete(memory.id, batch("delete-1", NOW + 2)).unwrap();
  db.undo(Some("delete-1"), None, NOW + 3).unwrap();
  // 按原来的 id 重新插入
  let restored = db.get(memory.id).unwrap().unwrap();
  assert_eq!(restored.content, "用户的生日是 5 月 3 日");
  assert_eq!(restored.importance, 0.95);
  assert_eq!(restored.created_at, NOW);

  // 撤销「再次提到」：恢复重要程度
  let reinforce = db.events(10).unwrap().into_iter().find(|e| e.action == EventAction::Reinforce).unwrap();
  assert!(reinforce.undoable);
  db.undo(None, Some(reinforce.id), NOW + 4).unwrap();
  assert_eq!(db.get(memory.id).unwrap().unwrap().importance, 0.9);
}

// ===== 遗忘 =====

#[test]
fn forgets_faded_memories() {
  let db = MemoryDb::open_in_memory().unwrap();
  let old = NOW - 400 * DAY;
  let trivial = db.add(new(Category::Episodic, "用户中午吃了面", 0.2, None), at(old)).unwrap();
  let important = db.add(new(Category::Episodic, "用户考上了研究生", 0.8, None), at(old)).unwrap();
  let core = db.add(new(Category::Profile, "用户叫小明", 0.9, None), at(old)).unwrap();
  let recent = db.add(new(Category::Episodic, "用户今天喝了奶茶", 0.2, None), at(NOW - DAY)).unwrap();
  let pinned = db.add(new(Category::Episodic, "用户第一次和桌宠说话", 0.2, None), at(old)).unwrap();
  db.update(pinned.id, MemoryPatch { pinned: Some(true), ..Default::default() }, at(old)).unwrap();

  let options = ForgetOptions::default();
  let candidates = db.forget_candidates(&options, NOW).unwrap();
  assert_eq!(candidates.iter().map(|c| c.memory.id).collect::<Vec<_>>(), vec![trivial.id]);
  assert!(candidates[0].retention < options.threshold);

  let forgotten = db.forget(&options, Change { source: Some("forget"), batch: Some("forget-1"), now: NOW }).unwrap();
  assert_eq!(forgotten.len(), 1);
  assert!(db.get(trivial.id).unwrap().is_none());
  for id in [important.id, core.id, recent.id, pinned.id] {
    assert!(db.get(id).unwrap().is_some());
  }

  // 遗忘可以撤销
  db.undo(Some("forget-1"), None, NOW + 1).unwrap();
  assert!(db.get(trivial.id).unwrap().is_some());
}

#[test]
fn lists_memories_with_retention() {
  let db = MemoryDb::open_in_memory().unwrap();
  db.add(new(Category::Episodic, "很久以前的事", 0.3, None), at(NOW - 300 * DAY)).unwrap();
  db.add(new(Category::Episodic, "刚发生的事", 0.3, None), at(NOW)).unwrap();
  let listed = db.list(None, false, 10, 0, NOW).unwrap();
  assert!((listed[0].retention - 1.0).abs() < 1e-9);
  assert!(listed[1].retention < 0.1);
}

#[test]
fn counts_changes_for_consolidation() {
  let db = MemoryDb::open_in_memory().unwrap();
  db.add(new(Category::Episodic, "a", 0.5, None), at(NOW)).unwrap();
  db.add(new(Category::Episodic, "b", 0.5, None), batch("turn-1", NOW + 2)).unwrap();
  // 整理与遗忘本身产生的变动不计入
  db.add(new(Category::Episodic, "c", 0.5, None), Change { source: Some("consolidate"), batch: None, now: NOW + 3 }).unwrap();
  assert_eq!(db.changes_since(NOW + 1).unwrap(), 1);
  assert_eq!(db.changes_since(0).unwrap(), 2);
}

#[test]
fn groups_memories_for_consolidation() {
  let db = MemoryDb::open_in_memory().unwrap();
  for content in ["用户喜欢猫", "用户很喜欢猫咪", "用户喜欢喝咖啡"] {
    db.add(new(Category::Preference, content, 0.5, None), at(NOW)).unwrap();
  }
  db.add(new(Category::Profile, "用户叫小明", 0.9, None), at(NOW)).unwrap();
  let groups = db.consolidation_groups(None, 40).unwrap();
  assert_eq!(groups.len(), 1, "只有一条记忆的类别不需要整理");
  assert_eq!(groups[0].len(), 3);
}

// ===== 迁移与持久化 =====

#[test]
fn migrates_from_version_one() {
  let conn = Connection::open_in_memory().unwrap();
  conn
    .execute_batch(
      "CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5, occurred_at INTEGER, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, last_accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0,
        source TEXT, embedding BLOB, embedding_model TEXT, archived INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO memories (category, content, created_at, updated_at) VALUES ('profile', '用户叫小明', 1, 1);
      PRAGMA user_version = 1;",
    )
    .unwrap();

  let db = MemoryDb::init(conn).unwrap();
  let memories = db.list(None, false, 10, 0, NOW).unwrap();
  assert_eq!(memories[0].memory.content, "用户叫小明");
  assert!(!memories[0].memory.pinned);
  let version: i32 = db.conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
  assert_eq!(version, SCHEMA_VERSION);
  db.add(new(Category::Episodic, "用户今天面试", 0.5, None), at(NOW)).unwrap();
  assert_eq!(db.events(10).unwrap().len(), 1);
}

#[test]
fn migrates_from_version_two_and_undoes_old_events() {
  let conn = Connection::open_in_memory().unwrap();
  conn
    .execute_batch(
      "CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5, occurred_at INTEGER, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, last_accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0,
        source TEXT, embedding BLOB, embedding_model TEXT, archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER NOT NULL, action TEXT NOT NULL,
        category TEXT NOT NULL, content TEXT NOT NULL, previous TEXT, source TEXT, created_at INTEGER NOT NULL
      );
      INSERT INTO memories (category, content, created_at, updated_at) VALUES ('profile', '用户住在上海', 1, 2);
      INSERT INTO memory_events (memory_id, action, category, content, previous, created_at)
        VALUES (1, 'update', 'profile', '用户住在上海', '用户住在杭州', 2);
      PRAGMA user_version = 2;",
    )
    .unwrap();

  let db = MemoryDb::init(conn).unwrap();
  let event = &db.events(10).unwrap()[0];
  assert!(event.undoable, "旧版本的修改记录有修改前的内容，可以撤销");
  db.undo(None, Some(event.id), NOW).unwrap();
  assert_eq!(db.get(1).unwrap().unwrap().content, "用户住在杭州");
}

#[test]
fn persists_to_file_and_reopens() {
  let dir = std::env::temp_dir().join(format!("desktop-pet-memory-test-{}", std::process::id()));
  std::fs::create_dir_all(&dir).unwrap();
  let path = dir.join("memory.db");
  let _ = std::fs::remove_file(&path);

  {
    let db = MemoryDb::open(&path).unwrap();
    db.add(new(Category::Profile, "用户叫小明", 0.9, Some(vec![1.0, 0.0])), at(NOW)).unwrap();
  }
  // 重新打开时不会重复建表，数据仍在
  let db = MemoryDb::open(&path).unwrap();
  assert_eq!(contents(&db), vec!["用户叫小明".to_string()]);
  let mode: String = db.conn.pragma_query_value(None, "journal_mode", |row| row.get(0)).unwrap();
  assert_eq!(mode.to_lowercase(), "wal");

  drop(db);
  let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn round_trips_embeddings() {
  let embedding = vec![0.25, -1.5, 3.0];
  assert_eq!(decode_embedding(&encode_embedding(&embedding)), Some(embedding));
  assert_eq!(decode_embedding(&[1, 2, 3]), None);
}
