//! 记忆的维护：遗忘曲线与整理分组

use std::collections::BTreeMap;

use super::model::{Category, ForgetOptions, Memory};
use super::rank::{cosine_similarity, Candidate, CORE_IMPORTANCE};

const DAY_MS: f64 = 86_400_000.0;

/// 重要程度为 0、从未被想起的记忆的稳定性（天）
const BASE_STABILITY_DAYS: f64 = 30.0;

/// 记忆强度：按艾宾浩斯遗忘曲线 R = e^(-t / S) 计算，范围 0 ~ 1。
///
/// - t：距离最近一次巩固（写入、更新、被想起）的天数。已经过去的计划从计划时间开始淡忘。
/// - S：稳定性，随重要程度与被想起的次数增长——越重要、越常被想起的记忆忘得越慢。
///   例如重要程度 0.5、从未被想起的记忆约 90 天后强度降到 37%，被想起过 3 次则延长到约 215 天。
///
/// 固定的记忆不会淡忘。
pub fn retention(memory: &Memory, now: i64) -> f64 {
  if memory.pinned {
    return 1.0;
  }
  let stability = BASE_STABILITY_DAYS
    * (1.0 + 4.0 * memory.importance.clamp(0.0, 1.0))
    * (1.0 + (1.0 + memory.access_count.max(0) as f64).ln());

  let last = memory.updated_at.max(memory.last_accessed_at.unwrap_or(0));
  let mut elapsed = (now - last).max(0) as f64 / DAY_MS;
  if memory.category == Category::Plan {
    if let Some(at) = memory.occurred_at.filter(|&at| at < now) {
      elapsed = elapsed.max((now - at) as f64 / DAY_MS);
    }
  }
  (-elapsed / stability).exp()
}

/// 是否应该遗忘：不固定、不太重要、不是核心档案、过了保护期，且记忆强度低于阈值
pub fn should_forget(memory: &Memory, now: i64, options: &ForgetOptions) -> bool {
  let is_core = memory.category == Category::Profile && memory.importance >= CORE_IMPORTANCE;
  let age_days = (now - memory.created_at).max(0) as f64 / DAY_MS;
  !memory.archived
    && !memory.pinned
    && !is_core
    && memory.importance < options.max_importance
    && age_days >= options.grace_days
    && retention(memory, now) < options.threshold
}

/// 把记忆分成交给 LLM 整理的若干组：同一类别的记忆为一组，太多时拆分。
/// 有向量时按「最近邻链」排序（每次接上与当前记忆最相似的一条），让相似的记忆尽量落在同一组；
/// 没有向量的记忆按内容排序后接在后面。固定的记忆不参与整理
pub fn consolidation_groups(candidates: Vec<Candidate>, max_group_size: usize) -> Vec<Vec<Memory>> {
  let max_group_size = max_group_size.max(2);
  let mut by_category: BTreeMap<usize, Vec<Candidate>> = BTreeMap::new();
  for candidate in candidates.into_iter().filter(|c| !c.memory.pinned && !c.memory.archived) {
    let order = Category::ALL.iter().position(|&c| c == candidate.memory.category).unwrap_or(usize::MAX);
    by_category.entry(order).or_default().push(candidate);
  }

  let mut groups = Vec::new();
  for (_, candidates) in by_category {
    let ordered = nearest_neighbor_order(candidates);
    // 均匀拆分，避免最后一组只剩一两条
    let chunks = ordered.len().div_ceil(max_group_size);
    if chunks == 0 {
      continue;
    }
    let size = ordered.len().div_ceil(chunks);
    let mut iter = ordered.into_iter().peekable();
    while iter.peek().is_some() {
      let group: Vec<Memory> = iter.by_ref().take(size).collect();
      if group.len() >= 2 {
        groups.push(group);
      }
    }
  }
  groups
}

/// 记忆太多时逐条比较的开销较大，退化为按内容排序
const MAX_NEAREST_NEIGHBOR: usize = 600;

fn nearest_neighbor_order(candidates: Vec<Candidate>) -> Vec<Memory> {
  let (mut embedded, mut rest): (Vec<Candidate>, Vec<Candidate>) =
    candidates.into_iter().partition(|c| c.embedding.is_some());
  rest.sort_by(|a, b| a.memory.content.cmp(&b.memory.content));

  if embedded.len() > MAX_NEAREST_NEIGHBOR {
    rest.append(&mut embedded);
    rest.sort_by(|a, b| a.memory.content.cmp(&b.memory.content));
    return rest.into_iter().map(|c| c.memory).collect();
  }

  // 从最早的记忆开始，每次接上与当前记忆最相似的、尚未排入的记忆
  embedded.sort_by_key(|c| c.memory.created_at);
  let mut ordered: Vec<Candidate> = Vec::with_capacity(embedded.len());
  let mut remaining = embedded;
  if !remaining.is_empty() {
    ordered.push(remaining.remove(0));
  }
  while !remaining.is_empty() {
    let current = ordered.last().and_then(|c| c.embedding.as_deref()).unwrap_or_default();
    let (index, _) = remaining
      .iter()
      .enumerate()
      .map(|(index, c)| {
        let embedding = c.embedding.as_deref().unwrap_or_default();
        let similarity = if embedding.len() == current.len() { cosine_similarity(current, embedding) } else { -1.0 };
        (index, similarity)
      })
      .max_by(|a, b| a.1.total_cmp(&b.1))
      .unwrap_or((0, 0.0));
    ordered.push(remaining.remove(index));
  }

  ordered.into_iter().chain(rest).map(|c| c.memory).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  const NOW: i64 = 1_800_000_000_000;

  fn memory(id: i64, category: Category, importance: f64, age_days: f64) -> Memory {
    let updated_at = NOW - (age_days * DAY_MS) as i64;
    Memory {
      id,
      category,
      content: format!("记忆 {id}"),
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

  #[test]
  fn retention_follows_forgetting_curve() {
    let fresh = memory(1, Category::Preference, 0.5, 0.0);
    assert!((retention(&fresh, NOW) - 1.0).abs() < 1e-9);

    // 重要程度 0.5、从未被想起：稳定性 90 天，90 天后强度约为 1/e
    let old = memory(2, Category::Preference, 0.5, 90.0);
    assert!((retention(&old, NOW) - (-1.0f64).exp()).abs() < 1e-6);

    // 越重要、被想起的次数越多，忘得越慢
    let important = memory(3, Category::Preference, 0.9, 90.0);
    let mut recalled = memory(4, Category::Preference, 0.5, 90.0);
    recalled.access_count = 3;
    assert!(retention(&important, NOW) > retention(&old, NOW));
    assert!(retention(&recalled, NOW) > retention(&old, NOW));

    // 被想起会重新巩固记忆
    let mut accessed = memory(5, Category::Preference, 0.5, 90.0);
    accessed.last_accessed_at = Some(NOW - DAY_MS as i64);
    assert!(retention(&accessed, NOW) > 0.95);

    // 固定的记忆不会淡忘
    let mut pinned = memory(6, Category::Episodic, 0.1, 1000.0);
    pinned.pinned = true;
    assert_eq!(retention(&pinned, NOW), 1.0);
  }

  #[test]
  fn past_plans_fade_from_their_date() {
    let mut plan = memory(1, Category::Plan, 0.5, 1.0);
    plan.occurred_at = Some(NOW - (200.0 * DAY_MS) as i64);
    assert!(retention(&plan, NOW) < retention(&memory(2, Category::Plan, 0.5, 1.0), NOW));
  }

  #[test]
  fn decides_what_to_forget() {
    let options = ForgetOptions::default();
    let faded = memory(1, Category::Episodic, 0.3, 365.0);
    assert!(should_forget(&faded, NOW, &options));

    let important = memory(2, Category::Episodic, 0.7, 365.0);
    assert!(!should_forget(&important, NOW, &options), "重要的记忆不会被遗忘");

    let core = memory(3, Category::Profile, 0.9, 3650.0);
    assert!(!should_forget(&core, NOW, &ForgetOptions { max_importance: 1.1, ..options }), "核心档案不会被遗忘");

    let mut pinned = memory(4, Category::Episodic, 0.1, 365.0);
    pinned.pinned = true;
    assert!(!should_forget(&pinned, NOW, &options), "固定的记忆不会被遗忘");

    let recent = memory(5, Category::Episodic, 0.1, 3.0);
    assert!(!should_forget(&recent, NOW, &ForgetOptions { threshold: 1.0, ..options }), "保护期内不会被遗忘");
  }

  fn candidate(id: i64, category: Category, embedding: Option<Vec<f32>>) -> Candidate {
    Candidate { memory: memory(id, category, 0.5, id as f64), embedding }
  }

  #[test]
  fn groups_similar_memories_by_category() {
    let candidates = vec![
      candidate(1, Category::Preference, Some(vec![1.0, 0.0])),
      candidate(2, Category::Preference, Some(vec![0.0, 1.0])),
      candidate(3, Category::Preference, Some(vec![0.95, 0.05])),
      candidate(4, Category::Preference, Some(vec![0.05, 0.95])),
      candidate(5, Category::Episodic, None),
      candidate(6, Category::Episodic, None),
      candidate(7, Category::Plan, None),
    ];
    let groups = consolidation_groups(candidates, 2);
    let ids: Vec<Vec<i64>> = groups.iter().map(|group| group.iter().map(|m| m.id).collect()).collect();

    // 偏好按相似度拆成两组；情景记忆一组；只有一条的计划不需要整理
    assert_eq!(ids.len(), 3);
    assert!(ids.contains(&vec![5, 6]) || ids.contains(&vec![6, 5]));
    let preference: Vec<&Vec<i64>> = ids.iter().filter(|group| group.contains(&1) || group.contains(&2)).collect();
    for group in preference {
      let mut sorted = group.clone();
      sorted.sort();
      assert!(sorted == vec![1, 3] || sorted == vec![2, 4], "相似的记忆应在同一组：{group:?}");
    }
  }

  #[test]
  fn skips_pinned_memories_when_grouping() {
    let mut pinned = candidate(1, Category::Preference, None);
    pinned.memory.pinned = true;
    let groups = consolidation_groups(vec![pinned, candidate(2, Category::Preference, None)], 10);
    assert!(groups.is_empty());
  }
}
