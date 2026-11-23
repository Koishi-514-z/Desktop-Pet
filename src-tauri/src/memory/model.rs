//! 记忆的数据结构

use serde::{Deserialize, Serialize};

/// 记忆类别。不同类别的记忆随时间「褪色」的速度不同
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
  /// 用户档案：姓名、职业、居住地等相对稳定的个人信息
  Profile,
  /// 偏好习惯：喜好、厌恶、习惯、作息
  Preference,
  /// 情景记忆：与用户之间发生过的具体事件
  Episodic,
  /// 计划约定：用户的计划、目标，以及与桌宠的约定
  Plan,
  /// 关系印象：桌宠对用户的整体印象、彼此关系的变化
  Relationship,
}

impl Category {
  pub const ALL: [Category; 5] = [
    Category::Profile,
    Category::Preference,
    Category::Episodic,
    Category::Plan,
    Category::Relationship,
  ];

  pub fn as_str(self) -> &'static str {
    match self {
      Category::Profile => "profile",
      Category::Preference => "preference",
      Category::Episodic => "episodic",
      Category::Plan => "plan",
      Category::Relationship => "relationship",
    }
  }

  pub fn parse(value: &str) -> Option<Self> {
    Self::ALL.into_iter().find(|category| category.as_str() == value)
  }

  /// 新近程度的半衰期（天）：经过这么久，新近程度降为一半。None 表示不随时间衰减
  pub fn half_life_days(self) -> Option<f64> {
    match self {
      Category::Profile => None,
      Category::Preference => Some(180.0),
      Category::Episodic => Some(30.0),
      Category::Plan => Some(21.0),
      Category::Relationship => Some(90.0),
    }
  }
}

/// 一条记忆
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
  pub id: i64,
  pub category: Category,
  pub content: String,
  /// 重要程度，0 ~ 1
  pub importance: f64,
  /// 事件发生（或计划进行）的时间，毫秒时间戳；为空时以 updated_at 为准
  pub occurred_at: Option<i64>,
  pub created_at: i64,
  pub updated_at: i64,
  /// 最近一次被检索到的时间
  pub last_accessed_at: Option<i64>,
  /// 被检索到的次数
  pub access_count: i64,
  /// 来源，如会话 id
  pub source: Option<String>,
  /// 生成向量所用的模型，为空表示还没有向量
  pub embedding_model: Option<String>,
  /// 已归档（被合并、遗忘或撤销）的记忆不再参与检索，可以恢复
  pub archived: bool,
  /// 固定的记忆不会被自动整理或遗忘
  pub pinned: bool,
}

/// 新增记忆的参数
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMemory {
  pub category: Option<Category>,
  pub content: String,
  pub importance: Option<f64>,
  pub occurred_at: Option<i64>,
  pub source: Option<String>,
  pub embedding: Option<Vec<f32>>,
  pub embedding_model: Option<String>,
}

/// 综合排名时各项指标的权重，使用前会归一化为总和 1
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Weights {
  pub relevance: f64,
  pub importance: f64,
  pub recency: f64,
}

impl Default for Weights {
  fn default() -> Self {
    Self { relevance: 0.6, importance: 0.25, recency: 0.15 }
  }
}

impl Weights {
  pub fn normalized(self) -> Self {
    let clamp = |v: f64| if v.is_finite() { v.max(0.0) } else { 0.0 };
    let (relevance, importance, recency) = (clamp(self.relevance), clamp(self.importance), clamp(self.recency));
    let sum = relevance + importance + recency;
    if sum <= f64::EPSILON {
      return Self::default();
    }
    Self { relevance: relevance / sum, importance: importance / sum, recency: recency / sum }
  }
}

fn default_limit() -> usize {
  6
}

fn default_core_limit() -> usize {
  5
}

fn default_touch() -> bool {
  true
}

/// 检索请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
  /// 查询文本，用于关键词匹配
  pub query: String,
  /// 查询文本的向量，用于语义匹配；为空时只做关键词匹配
  #[serde(default)]
  pub embedding: Option<Vec<f32>>,
  /// 生成查询向量所用的模型，只与同一模型生成的记忆向量比较
  #[serde(default)]
  pub embedding_model: Option<String>,
  /// 最多返回多少条按综合得分排名的记忆（不含核心档案）
  #[serde(default = "default_limit")]
  pub limit: usize,
  /// 最多附带多少条核心档案
  #[serde(default = "default_core_limit")]
  pub core_limit: usize,
  #[serde(default)]
  pub weights: Weights,
  /// 当前时间（毫秒），省略时使用系统时间，便于测试
  #[serde(default)]
  pub now: Option<i64>,
  /// 是否记录访问（更新最近访问时间与次数）
  #[serde(default = "default_touch")]
  pub touch: bool,
}

/// 带有得分的记忆
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoredMemory {
  #[serde(flatten)]
  pub memory: Memory,
  /// 综合得分
  pub score: f64,
  /// 相关性，0 ~ 1
  pub relevance: f64,
  /// 新近程度，0 ~ 1
  pub recency: f64,
  /// 是否为每次都会附带的核心档案
  pub core: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
  /// 核心档案在前，其余按综合得分从高到低
  pub memories: Vec<ScoredMemory>,
  /// 是否使用了语义匹配
  pub semantic: bool,
  /// 没有当前模型向量的记忆数量（这些记忆只能做关键词匹配，需要补全向量）
  pub missing_embeddings: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
  pub total: usize,
  pub by_category: Vec<(Category, usize)>,
  /// 没有指定模型向量的记忆数量
  pub missing_embeddings: usize,
  /// 已归档的记忆数量
  pub archived: usize,
}

/// 需要生成向量的记忆
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingEmbedding {
  pub id: i64,
  pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingItem {
  pub id: i64,
  pub embedding: Vec<f32>,
}

/// 修改记忆的参数，省略的字段保持不变。
/// 修改了内容但没有提供新向量时，旧向量会被清除，之后由前端补全
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPatch {
  pub content: Option<String>,
  pub category: Option<Category>,
  pub importance: Option<f64>,
  pub occurred_at: Option<i64>,
  pub pinned: Option<bool>,
  pub embedding: Option<Vec<f32>>,
  pub embedding_model: Option<String>,
}

fn default_similar_limit() -> usize {
  5
}

/// 查找与一段内容相似的已有记忆（用于写入前去重）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarRequest {
  pub content: String,
  #[serde(default)]
  pub embedding: Option<Vec<f32>>,
  #[serde(default)]
  pub embedding_model: Option<String>,
  #[serde(default = "default_similar_limit")]
  pub limit: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarMemory {
  #[serde(flatten)]
  pub memory: Memory,
  /// 语义相似度（余弦相似度），没有可比较的向量时为空
  pub similarity: Option<f32>,
  /// 关键词匹配得分，0 ~ 1
  pub lexical: f64,
}

/// 记忆变动的类型
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventAction {
  /// 新增
  Add,
  /// 修改内容（合并、修正）
  Update,
  /// 再次提到已有的记忆
  Reinforce,
  /// 归档（如被合并到其他记忆中、被遗忘），不再参与检索
  Archive,
  /// 从归档中恢复
  Restore,
  /// 删除
  Delete,
}

impl EventAction {
  pub fn as_str(self) -> &'static str {
    match self {
      EventAction::Add => "add",
      EventAction::Update => "update",
      EventAction::Reinforce => "reinforce",
      EventAction::Archive => "archive",
      EventAction::Restore => "restore",
      EventAction::Delete => "delete",
    }
  }

  pub fn parse(value: &str) -> Option<Self> {
    [
      EventAction::Add,
      EventAction::Update,
      EventAction::Reinforce,
      EventAction::Archive,
      EventAction::Restore,
      EventAction::Delete,
    ]
      .into_iter()
      .find(|action| action.as_str() == value)
  }
}

/// 一次记忆变动的记录，便于了解记忆是怎么来的，以及撤销误操作
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvent {
  pub id: i64,
  pub memory_id: i64,
  pub action: EventAction,
  pub category: Category,
  /// 变动后的内容（删除、归档时为被删除的内容）
  pub content: String,
  /// 修改前的内容
  pub previous: Option<String>,
  /// 变动来源，如 chat:会话 id（对话后自动整理）、manual（手动）、consolidate（整理）、forget（遗忘）
  pub source: Option<String>,
  /// 同一次操作（如一轮对话后的整理、一次记忆整理）产生的变动属于同一批，撤销时整批撤销
  pub batch_id: Option<String>,
  pub created_at: i64,
  /// 被撤销的时间
  pub undone_at: Option<i64>,
  /// 现在能否撤销（之后同一条记忆又有其他变动时不能撤销）
  pub undoable: bool,
}

/// 记忆在变动前的状态，用于撤销（不含向量，撤销后由前端补全）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
  pub category: Category,
  pub content: String,
  pub importance: f64,
  pub occurred_at: Option<i64>,
  pub created_at: i64,
  pub updated_at: i64,
  pub last_accessed_at: Option<i64>,
  pub access_count: i64,
  pub source: Option<String>,
  pub archived: bool,
  pub pinned: bool,
}

impl From<&Memory> for MemorySnapshot {
  fn from(memory: &Memory) -> Self {
    Self {
      category: memory.category,
      content: memory.content.clone(),
      importance: memory.importance,
      occurred_at: memory.occurred_at,
      created_at: memory.created_at,
      updated_at: memory.updated_at,
      last_accessed_at: memory.last_accessed_at,
      access_count: memory.access_count,
      source: memory.source.clone(),
      archived: memory.archived,
      pinned: memory.pinned,
    }
  }
}

/// 记忆库列表中的记忆，附带当前的记忆强度
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedMemory {
  #[serde(flatten)]
  pub memory: Memory,
  /// 记忆强度（按遗忘曲线计算），0 ~ 1
  pub retention: f64,
}

fn default_forget_threshold() -> f64 {
  0.15
}

fn default_forget_max_importance() -> f64 {
  0.6
}

fn default_grace_days() -> f64 {
  7.0
}

/// 遗忘的条件
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetOptions {
  /// 记忆强度低于该值的记忆会被遗忘
  #[serde(default = "default_forget_threshold")]
  pub threshold: f64,
  /// 重要程度不低于该值的记忆不会被遗忘
  #[serde(default = "default_forget_max_importance")]
  pub max_importance: f64,
  /// 新写入的记忆在这么多天内不会被遗忘
  #[serde(default = "default_grace_days")]
  pub grace_days: f64,
}

impl Default for ForgetOptions {
  fn default() -> Self {
    Self {
      threshold: default_forget_threshold(),
      max_importance: default_forget_max_importance(),
      grace_days: default_grace_days(),
    }
  }
}
