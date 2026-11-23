//! 记忆的综合排名
//!
//! 综合得分 = 相关性 × w1 + 重要程度 × w2 + 新近程度 × w3
//!
//! - 相关性：有查询向量时以语义相似度（余弦相似度）为主、关键词匹配为辅；否则只用关键词匹配。
//!   相关性低于门槛的记忆不参与排名，避免「很重要但与当前话题无关」的记忆被塞进 Prompt。
//! - 重要程度：记忆写入时给出，0 ~ 1。
//! - 新近程度：按类别的半衰期指数衰减，用户档案不衰减。
//!
//! 另外，重要程度很高的用户档案（如名字）作为「核心档案」每次都会附带，不参与排名。

use std::collections::{HashMap, HashSet};

use super::model::{Category, Memory, ScoredMemory, SimilarMemory, Weights};

/// 重要程度不低于该值的用户档案视为核心档案
pub const CORE_IMPORTANCE: f64 = 0.8;
/// 有语义相似度时，相关性中语义部分的占比（其余为关键词匹配）
const SEMANTIC_SHARE: f64 = 0.75;
/// 参与排名的相关性门槛（有语义相似度 / 只有关键词匹配）
const MIN_RELEVANCE_SEMANTIC: f64 = 0.3;
const MIN_RELEVANCE_LEXICAL: f64 = 0.2;
/// 语义相似度的样本足够多且有区分度时，按「第 10 百分位 ~ 最大值」归一化；
/// 不同向量模型的余弦相似度分布差别很大（无关文本可能是 0.1，也可能是 0.4），归一化后门槛才通用。
/// 下界取第 10 百分位而不是最小值，避免个别离群的记忆把整体拉低
const MIN_NORMALIZE_COUNT: usize = 5;
const MIN_SIMILARITY_SPREAD: f32 = 0.05;
/// 关键词得分的饱和常数：匹配到的词越罕见、越多，得分越接近 1
const LEXICAL_SATURATION: f64 = 1.5;
const DAY_MS: f64 = 86_400_000.0;

/// 参与排名的记忆
pub struct Candidate {
  pub memory: Memory,
  /// 与查询向量同一模型生成的记忆向量
  pub embedding: Option<Vec<f32>>,
}

pub struct RankOptions<'a> {
  pub query: &'a str,
  pub query_embedding: Option<&'a [f32]>,
  pub limit: usize,
  pub core_limit: usize,
  pub weights: Weights,
  pub now: i64,
}

pub struct Ranked {
  pub memories: Vec<ScoredMemory>,
  pub semantic: bool,
  pub missing_embeddings: usize,
}

pub fn rank(candidates: Vec<Candidate>, options: &RankOptions) -> Ranked {
  let weights = options.weights.normalized();

  // ===== 语义相似度 =====
  let similarities: Vec<Option<f32>> = candidates
    .iter()
    .map(|c| match (options.query_embedding, c.embedding.as_deref()) {
      (Some(query), Some(embedding)) if query.len() == embedding.len() => Some(cosine_similarity(query, embedding)),
      _ => None,
    })
    .collect();
  let missing_embeddings = if options.query_embedding.is_some() {
    similarities.iter().filter(|s| s.is_none()).count()
  } else {
    0
  };
  let semantic = similarities.iter().any(Option::is_some);
  let normalize = semantic_normalizer(&similarities);

  // ===== 关键词匹配 =====
  let query_tokens = tokenize(options.query);
  let document_tokens: Vec<HashSet<String>> = candidates.iter().map(|c| tokenize(&c.memory.content)).collect();
  let idf = inverse_document_frequency(&query_tokens, &document_tokens);

  let mut core = Vec::new();
  let mut ranked = Vec::new();
  for ((candidate, similarity), tokens) in candidates.into_iter().zip(similarities).zip(document_tokens.iter()) {
    let lexical = lexical_score(&query_tokens, tokens, &idf);
    let (relevance, threshold) = match similarity {
      Some(similarity) => (SEMANTIC_SHARE * normalize(similarity) + (1.0 - SEMANTIC_SHARE) * lexical, MIN_RELEVANCE_SEMANTIC),
      None => (lexical, MIN_RELEVANCE_LEXICAL),
    };
    let memory = candidate.memory;
    let recency = recency(&memory, options.now);
    let score = weights.relevance * relevance + weights.importance * memory.importance + weights.recency * recency;

    let is_core = memory.category == Category::Profile && memory.importance >= CORE_IMPORTANCE;
    let scored = ScoredMemory { memory, score, relevance, recency, core: false };
    if is_core {
      core.push(scored);
    } else if relevance >= threshold {
      ranked.push(scored);
    }
  }

  // 核心档案按重要程度选取，超出数量的部分与其他记忆一起参与排名
  core.sort_by(|a, b| {
    b.memory.importance
      .total_cmp(&a.memory.importance)
      .then(b.memory.updated_at.cmp(&a.memory.updated_at))
  });
  let overflow = core.split_off(options.core_limit.min(core.len()));
  for mut memory in overflow {
    let threshold = if semantic { MIN_RELEVANCE_SEMANTIC } else { MIN_RELEVANCE_LEXICAL };
    if memory.relevance >= threshold {
      memory.core = false;
      ranked.push(memory);
    }
  }
  core.iter_mut().for_each(|memory| memory.core = true);

  ranked.sort_by(|a, b| b.score.total_cmp(&a.score).then(b.memory.updated_at.cmp(&a.memory.updated_at)));
  ranked.truncate(options.limit);

  core.extend(ranked);
  Ranked { memories: core, semantic, missing_embeddings }
}

/// 新近程度：按类别的半衰期指数衰减；事件时间在未来（如计划）时为 1
pub fn recency(memory: &Memory, now: i64) -> f64 {
  let Some(half_life) = memory.category.half_life_days() else {
    return 1.0;
  };
  let anchor = memory.occurred_at.unwrap_or(memory.updated_at);
  let age_days = (now - anchor).max(0) as f64 / DAY_MS;
  0.5f64.powf(age_days / half_life)
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
  let (mut dot, mut norm_a, mut norm_b) = (0.0f32, 0.0f32, 0.0f32);
  for (x, y) in a.iter().zip(b) {
    dot += x * y;
    norm_a += x * x;
    norm_b += y * y;
  }
  if norm_a <= f32::EPSILON || norm_b <= f32::EPSILON {
    return 0.0;
  }
  dot / (norm_a.sqrt() * norm_b.sqrt())
}

/// 根据所有记忆的语义相似度确定归一化方式
fn semantic_normalizer(similarities: &[Option<f32>]) -> impl Fn(f32) -> f64 + use<> {
  let mut values: Vec<f32> = similarities.iter().flatten().copied().collect();
  values.sort_by(f32::total_cmp);
  let low = values.get(values.len() / 10).copied().unwrap_or(0.0);
  let high = values.last().copied().unwrap_or(1.0);
  let normalize = values.len() >= MIN_NORMALIZE_COUNT && high - low >= MIN_SIMILARITY_SPREAD;

  move |similarity: f32| {
    let value = if normalize { (similarity - low) / (high - low) } else { similarity };
    f64::from(value).clamp(0.0, 1.0)
  }
}

/// 分词：中日韩文字按相邻两字切分（单字成词时保留单字），其他文字按单词切分并转为小写
pub fn tokenize(text: &str) -> HashSet<String> {
  fn flush_cjk(run: &mut Vec<char>, tokens: &mut HashSet<String>) {
    match run.len() {
      0 => {}
      1 => {
        tokens.insert(run[0].to_string());
      }
      _ => {
        for pair in run.windows(2) {
          tokens.insert(pair.iter().collect());
        }
      }
    }
    run.clear();
  }

  fn flush_word(word: &mut String, tokens: &mut HashSet<String>) {
    if word.chars().count() >= 2 {
      tokens.insert(std::mem::take(word));
    }
    word.clear();
  }

  let mut tokens = HashSet::new();
  let mut run = Vec::new();
  let mut word = String::new();
  for c in text.chars().flat_map(char::to_lowercase) {
    if is_cjk(c) {
      flush_word(&mut word, &mut tokens);
      run.push(c);
    } else if c.is_alphanumeric() {
      flush_cjk(&mut run, &mut tokens);
      word.push(c);
    } else {
      flush_cjk(&mut run, &mut tokens);
      flush_word(&mut word, &mut tokens);
    }
  }
  flush_cjk(&mut run, &mut tokens);
  flush_word(&mut word, &mut tokens);
  tokens
}

fn is_cjk(c: char) -> bool {
  matches!(c as u32,
    0x3040..=0x30FF     // 日文假名
    | 0x3400..=0x4DBF   // 汉字扩展 A
    | 0x4E00..=0x9FFF   // 常用汉字
    | 0xAC00..=0xD7AF   // 韩文
    | 0xF900..=0xFAFF)  // 兼容汉字
}

/// 查询中各个词的逆文档频率：在记忆中越少见的词越有区分度。
/// 使用 ln(1 + N / df)，记忆很少时（如只有一条）也能得到有意义的权重，最常见的词权重为 ln 2
fn inverse_document_frequency(query: &HashSet<String>, documents: &[HashSet<String>]) -> HashMap<String, f64> {
  let n = documents.len() as f64;
  query
    .iter()
    .map(|token| {
      let df = documents.iter().filter(|doc| doc.contains(token)).count().max(1) as f64;
      (token.clone(), (1.0 + n / df).ln())
    })
    .collect()
}

/// 关键词得分：匹配到的词的逆文档频率之和，经过饱和处理映射到 0 ~ 1
fn lexical_score(query: &HashSet<String>, document: &HashSet<String>, idf: &HashMap<String, f64>) -> f64 {
  let sum: f64 = query.intersection(document).map(|token| idf.get(token).copied().unwrap_or(0.0)).sum();
  sum / (sum + LEXICAL_SATURATION)
}

/// 找出与一段内容最相似的记忆（写入新记忆前用于去重）。
/// 只看相似度，不考虑重要程度与新近程度；有向量时以语义相似度为主，没有向量的记忆只按关键词匹配
pub fn similar(candidates: Vec<Candidate>, content: &str, query_embedding: Option<&[f32]>, limit: usize) -> Vec<SimilarMemory> {
  let query_tokens = tokenize(content);
  let document_tokens: Vec<HashSet<String>> = candidates.iter().map(|c| tokenize(&c.memory.content)).collect();
  let idf = inverse_document_frequency(&query_tokens, &document_tokens);

  let mut scored: Vec<(f64, SimilarMemory)> = candidates
    .into_iter()
    .zip(document_tokens.iter())
    .filter_map(|(candidate, tokens)| {
      let lexical = lexical_score(&query_tokens, tokens, &idf);
      let similarity = match (query_embedding, candidate.embedding.as_deref()) {
        (Some(query), Some(embedding)) if query.len() == embedding.len() => Some(cosine_similarity(query, embedding)),
        _ => None,
      };
      let score = match similarity {
        Some(similarity) => 0.8 * f64::from(similarity) + 0.2 * lexical,
        // 没有可比较的向量时只有关键词得分，打个折扣，避免排在语义相近的记忆前面
        None => 0.8 * lexical,
      };
      (score > 0.0).then(|| (score, SimilarMemory { memory: candidate.memory, similarity, lexical }))
    })
    .collect();

  scored.sort_by(|a, b| b.0.total_cmp(&a.0));
  scored.into_iter().take(limit).map(|(_, memory)| memory).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  const NOW: i64 = 1_800_000_000_000;

  fn memory(id: i64, category: Category, content: &str, importance: f64, age_days: f64) -> Memory {
    let updated_at = NOW - (age_days * DAY_MS) as i64;
    Memory {
      id,
      category,
      content: content.into(),
      importance,
      occurred_at: None,
      created_at: updated_at,
      updated_at,
      last_accessed_at: None,
      access_count: 0,
      source: None,
      embedding_model: None,
      archived: false,
      pinned: false,
    }
  }

  fn candidate(memory: Memory, embedding: Option<Vec<f32>>) -> Candidate {
    Candidate { memory, embedding }
  }

  fn options<'a>(query: &'a str, embedding: Option<&'a [f32]>) -> RankOptions<'a> {
    RankOptions { query, query_embedding: embedding, limit: 10, core_limit: 5, weights: Weights::default(), now: NOW }
  }

  fn ids(ranked: &Ranked) -> Vec<i64> {
    ranked.memories.iter().map(|m| m.memory.id).collect()
  }

  #[test]
  fn tokenizes_mixed_text() {
    let tokens = tokenize("我喜欢 Rust 和 VS Code，猫");
    // 汉字按相邻两字切分，被隔开的单字保留为单字；英文转小写；单个字母不算词
    for token in ["我喜", "喜欢", "rust", "vs", "code", "和", "猫"] {
      assert!(tokens.contains(token), "{token}");
    }
    assert!(!tokens.contains("我"));
  }

  #[test]
  fn recency_decays_by_category() {
    let profile = memory(1, Category::Profile, "", 0.5, 365.0);
    let episodic = memory(2, Category::Episodic, "", 0.5, 30.0);
    assert_eq!(recency(&profile, NOW), 1.0);
    assert!((recency(&episodic, NOW) - 0.5).abs() < 1e-9);

    let mut plan = memory(3, Category::Plan, "", 0.5, 10.0);
    plan.occurred_at = Some(NOW + 86_400_000);
    assert_eq!(recency(&plan, NOW), 1.0);
  }

  #[test]
  fn ranks_by_semantic_similarity() {
    let query = [1.0, 0.0, 0.0];
    let candidates = vec![
      candidate(memory(1, Category::Episodic, "a", 0.5, 1.0), Some(vec![0.0, 1.0, 0.0])),
      candidate(memory(2, Category::Episodic, "b", 0.5, 1.0), Some(vec![0.9, 0.1, 0.0])),
      candidate(memory(3, Category::Episodic, "c", 0.5, 1.0), Some(vec![0.6, 0.6, 0.0])),
      candidate(memory(4, Category::Episodic, "d", 0.5, 1.0), Some(vec![0.0, 0.0, 1.0])),
      candidate(memory(5, Category::Episodic, "e", 0.5, 1.0), Some(vec![0.0, 0.7, 0.7])),
    ];
    let ranked = rank(candidates, &options("", Some(&query)));
    assert!(ranked.semantic);
    // 与查询无关的记忆被相关性门槛过滤
    assert_eq!(ids(&ranked), vec![2, 3]);
  }

  #[test]
  fn normalization_ignores_outliers() {
    let query = [1.0, 0.0];
    // 一条余弦相似度为 -1 的离群记忆不应让无关的记忆（相似度 0）显得相关
    let mut candidates: Vec<Candidate> = (1..=9)
      .map(|id| candidate(memory(id, Category::Episodic, "x", 0.5, 1.0), Some(vec![0.0, 1.0])))
      .collect();
    candidates.push(candidate(memory(10, Category::Episodic, "y", 0.5, 1.0), Some(vec![1.0, 0.0])));
    candidates.push(candidate(memory(11, Category::Episodic, "z", 0.5, 1.0), Some(vec![-1.0, 0.0])));
    let ranked = rank(candidates, &options("", Some(&query)));
    assert_eq!(ids(&ranked), vec![10]);
  }

  #[test]
  fn importance_and_recency_break_ties() {
    let query = [1.0, 0.0];
    let same = Some(vec![1.0, 0.0]);
    let candidates = vec![
      candidate(memory(1, Category::Episodic, "a", 0.2, 1.0), same.clone()),
      candidate(memory(2, Category::Episodic, "b", 0.9, 1.0), same.clone()),
      candidate(memory(3, Category::Episodic, "c", 0.2, 200.0), same.clone()),
    ];
    let ranked = rank(candidates, &options("", Some(&query)));
    assert_eq!(ids(&ranked), vec![2, 1, 3]);
  }

  #[test]
  fn falls_back_to_keywords_without_embeddings() {
    let candidates = vec![
      candidate(memory(1, Category::Preference, "用户喜欢喝拿铁咖啡", 0.5, 1.0), None),
      candidate(memory(2, Category::Episodic, "用户上周去爬了泰山", 0.5, 1.0), None),
      candidate(memory(3, Category::Preference, "用户养了一只橘猫", 0.5, 1.0), None),
    ];
    let ranked = rank(candidates, &options("今天又去喝咖啡了", None));
    assert!(!ranked.semantic);
    assert_eq!(ids(&ranked), vec![1]);
  }

  #[test]
  fn always_includes_core_profile() {
    let query = [1.0, 0.0];
    let candidates = vec![
      candidate(memory(1, Category::Profile, "用户叫小明", 0.9, 100.0), Some(vec![0.0, 1.0])),
      candidate(memory(2, Category::Profile, "用户住在杭州", 0.5, 100.0), Some(vec![0.0, 1.0])),
      candidate(memory(3, Category::Episodic, "相关的事", 0.5, 1.0), Some(vec![1.0, 0.0])),
    ];
    let ranked = rank(candidates, &options("", Some(&query)));
    assert_eq!(ids(&ranked), vec![1, 3]);
    assert!(ranked.memories[0].core);
    assert!(!ranked.memories[1].core);
  }

  #[test]
  fn counts_memories_without_matching_embeddings() {
    let query = [1.0, 0.0];
    let candidates = vec![
      candidate(memory(1, Category::Episodic, "a", 0.5, 1.0), Some(vec![1.0, 0.0])),
      candidate(memory(2, Category::Episodic, "b", 0.5, 1.0), None),
      // 维度不同（换了向量模型），视为缺少向量
      candidate(memory(3, Category::Episodic, "c", 0.5, 1.0), Some(vec![1.0, 0.0, 0.0])),
    ];
    let ranked = rank(candidates, &options("", Some(&query)));
    assert_eq!(ranked.missing_embeddings, 2);
  }

  #[test]
  fn finds_similar_memories() {
    let query = [1.0, 0.0];
    let candidates = vec![
      candidate(memory(1, Category::Profile, "用户住在杭州", 0.8, 10.0), Some(vec![0.9, 0.1])),
      candidate(memory(2, Category::Preference, "用户喜欢猫", 0.5, 10.0), Some(vec![0.0, 1.0])),
      // 没有向量的记忆按关键词匹配
      candidate(memory(3, Category::Profile, "用户搬到了上海", 0.8, 10.0), None),
      candidate(memory(4, Category::Episodic, "完全无关", 0.5, 10.0), None),
    ];
    let found = similar(candidates, "用户搬到了上海工作", Some(&query), 3);
    let ids: Vec<i64> = found.iter().map(|m| m.memory.id).collect();
    // 语义相近的排最前，其次是关键词大量重合的；完全无关的不返回
    assert_eq!(ids, vec![1, 3, 2]);
    assert!(found[0].similarity.is_some());
    assert!(found[1].similarity.is_none() && found[1].lexical > 0.0);
  }

  #[test]
  fn respects_limits() {
    let query = [1.0, 0.0];
    let candidates = (1..=10)
      .map(|id| candidate(memory(id, Category::Episodic, "x", 0.5, id as f64), Some(vec![1.0, 0.0])))
      .chain((11..=13).map(|id| candidate(memory(id, Category::Profile, "p", 0.9, 1.0), Some(vec![1.0, 0.0]))))
      .collect();
    let ranked = rank(candidates, &RankOptions { limit: 3, core_limit: 2, ..options("", Some(&query)) });
    assert_eq!(ranked.memories.iter().filter(|m| m.core).count(), 2);
    assert_eq!(ranked.memories.iter().filter(|m| !m.core).count(), 3);
  }
}
