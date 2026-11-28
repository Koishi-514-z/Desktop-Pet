//! 系统诊断（「系统诊断」技能）：采集 CPU、GPU、内存、显存、磁盘、网络、电池与进程的状态，交给前端的模型分析。
//!
//! - CPU、内存、进程、磁盘、网络：sysinfo，采样约 1 秒，用两次刷新之间的差值算出占用率与速率；
//! - GPU 占用与显存（Windows）：性能计数器（任务管理器用的也是这些计数器），显卡名称与显存总量来自 DXGI；
//! - 电池（Windows）：GetSystemPowerStatus。
//!
//! 进程按名称合并（如几十个 chrome 进程算作一个），排序与挑选交给前端。

use std::collections::HashMap;

use serde::Serialize;

/// 采样时间：CPU 占用率、读写与网络速率都是这段时间内的平均值
const SAMPLE_MS: u64 = 1000;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
  name: String,
  physical_cores: Option<usize>,
  logical_cores: usize,
  /// 总占用率（%）
  usage: f32,
  frequency_mhz: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
  total: u64,
  used: u64,
  available: u64,
  swap_total: u64,
  swap_used: u64,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
  name: String,
  /// 独立显存总量（集成显卡通常很小或为 0，使用共享内存）
  dedicated_total: u64,
  dedicated_used: Option<u64>,
  shared_used: Option<u64>,
  /// 占用率（%）：各类引擎（3D、视频编解码、复制等）中最高的一类
  usage: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
  mount: String,
  total: u64,
  available: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
  name: String,
  /// 每秒接收、发送的字节数
  received_per_sec: u64,
  sent_per_sec: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryInfo {
  percent: Option<u8>,
  plugged_in: bool,
  charging: bool,
  /// 剩余使用时间（秒），充电中或无法估计时为空
  remaining_seconds: Option<u32>,
  saver: bool,
}

/// 同名进程合并后的状态
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessGroup {
  name: String,
  count: usize,
  /// 占用最多的几个进程的 pid
  pids: Vec<u32>,
  /// 占整机 CPU 的百分比（最多 100）
  cpu: f32,
  memory: u64,
  gpu_memory: u64,
  gpu_shared_memory: u64,
  /// GPU 占用率（%），同一块显卡上各类引擎中最高的一类
  gpu_usage: f64,
  disk_read_per_sec: u64,
  disk_write_per_sec: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
  os: String,
  uptime_seconds: u64,
  sample_seconds: f64,
  cpu: CpuInfo,
  memory: MemoryInfo,
  gpus: Vec<GpuInfo>,
  disks: Vec<DiskInfo>,
  network: Vec<NetworkInfo>,
  battery: Option<BatteryInfo>,
  process_count: usize,
  processes: Vec<ProcessGroup>,
}

#[tauri::command]
pub async fn diagnostics_snapshot() -> Result<SystemSnapshot, String> {
  tauri::async_runtime::spawn_blocking(snapshot).await.map_err(|e| e.to_string())?
}

/// GPU 性能计数器的实例名，如 `pid_1234_luid_0x00000000_0x0000D1A3_phys_0_eng_0_engtype_3D`
#[derive(Debug, PartialEq, Eq)]
struct GpuInstance {
  pid: Option<u32>,
  /// 显卡的 LUID，如 `0x00000000_0x0000D1A3`（大写）
  luid: Option<String>,
  engine_type: Option<String>,
}

fn parse_gpu_instance(name: &str) -> GpuInstance {
  let pid = name.strip_prefix("pid_").and_then(|rest| rest.split('_').next()).and_then(|pid| pid.parse().ok());
  let luid = name.find("luid_").and_then(|start| {
    let parts: Vec<&str> = name[start + 5..].splitn(3, '_').collect();
    (parts.len() >= 2).then(|| format!("{}_{}", parts[0], parts[1]).to_uppercase().replace("0X", "0x"))
  });
  let engine_type = name.find("engtype_").map(|start| name[start + 8..].to_string());
  GpuInstance { pid, luid, engine_type }
}

/// GPU 引擎的占用率 → 每个进程（按 pid）与每块显卡（按 LUID）的占用率。
/// 与任务管理器相同：先按引擎类型累加，再取最高的一类
fn engine_usage(items: &[(String, f64)]) -> (HashMap<u32, f64>, HashMap<String, f64>) {
  let mut by_process: HashMap<(u32, String), f64> = HashMap::new();
  let mut by_adapter: HashMap<(String, String), f64> = HashMap::new();
  for (name, value) in items {
    let instance = parse_gpu_instance(name);
    let Some(engine) = instance.engine_type else { continue };
    if let Some(pid) = instance.pid {
      *by_process.entry((pid, engine.clone())).or_default() += value;
    }
    if let Some(luid) = instance.luid {
      *by_adapter.entry((luid, engine)).or_default() += value;
    }
  }
  let mut process: HashMap<u32, f64> = HashMap::new();
  for ((pid, _), value) in by_process {
    let entry = process.entry(pid).or_default();
    *entry = entry.max(value.min(100.0));
  }
  let mut adapter: HashMap<String, f64> = HashMap::new();
  for ((luid, _), value) in by_adapter {
    let entry = adapter.entry(luid).or_default();
    *entry = entry.max(value.min(100.0));
  }
  (process, adapter)
}

/// 按 pid 或 LUID 累加显存（一个进程在一块显卡上可能有多个实例）
fn memory_by<K: std::hash::Hash + Eq>(items: &[(String, i64)], key: impl Fn(&GpuInstance) -> Option<K>) -> HashMap<K, u64> {
  let mut result = HashMap::new();
  for (name, value) in items {
    if let Some(k) = key(&parse_gpu_instance(name)) {
      *result.entry(k).or_default() += (*value).max(0) as u64;
    }
  }
  result
}

/// 同一块显卡可能被 DXGI 以不同的 LUID 列出两次（如混合显卡的笔记本），其中一个没有任何计数器数据：
/// 有同名、带数据的显卡时，去掉没有数据的那个
fn dedupe_gpus(gpus: Vec<GpuInfo>) -> Vec<GpuInfo> {
  let has_data = |gpu: &GpuInfo| gpu.dedicated_used.is_some() || gpu.usage.is_some();
  gpus
    .iter()
    .filter(|gpu| has_data(gpu) || !gpus.iter().any(|other| other.name == gpu.name && has_data(other)))
    .cloned()
    .collect()
}

/// 一次 GPU 采样
#[derive(Default)]
struct GpuSample {
  /// 显卡：LUID、名称、独立显存总量
  adapters: Vec<(String, String, u64)>,
  engines: Vec<(String, f64)>,
  process_dedicated: Vec<(String, i64)>,
  process_shared: Vec<(String, i64)>,
  adapter_dedicated: Vec<(String, i64)>,
  adapter_shared: Vec<(String, i64)>,
}

fn snapshot() -> Result<SystemSnapshot, String> {
  use sysinfo::{Disks, Networks, ProcessesToUpdate, System};

  let mut system = System::new().map_err(|e| format!("无法读取系统状态：{e}"))?;
  let mut networks = Networks::new_with_refreshed_list().ok();
  let gpu_query = gpu::Query::open();

  system.refresh_cpu_all();
  system.refresh_memory();
  system.refresh_processes(ProcessesToUpdate::All, true);
  if let Some(query) = &gpu_query {
    query.collect();
  }

  let started = std::time::Instant::now();
  std::thread::sleep(std::time::Duration::from_millis(SAMPLE_MS));

  system.refresh_cpu_all();
  system.refresh_processes(ProcessesToUpdate::All, true);
  if let Some(networks) = networks.as_mut() {
    networks.refresh(true);
  }
  let gpu_sample = gpu_query.as_ref().map(|query| {
    query.collect();
    query.read()
  });
  let seconds = started.elapsed().as_secs_f64().max(0.001);
  let per_sec = |bytes: u64| (bytes as f64 / seconds) as u64;

  let logical_cores = system.cpus().len().max(1);
  let cpu = CpuInfo {
    name: system.cpus().first().map(|cpu| cpu.brand().trim().to_string()).unwrap_or_default(),
    physical_cores: System::physical_core_count().ok(),
    logical_cores,
    usage: system.global_cpu_usage(),
    frequency_mhz: system.cpus().first().map(|cpu| cpu.frequency()).unwrap_or(0),
  };
  let memory = MemoryInfo {
    total: system.total_memory(),
    used: system.used_memory(),
    available: system.available_memory(),
    swap_total: system.total_swap(),
    swap_used: system.used_swap(),
  };

  // GPU：每块显卡、每个进程
  let sample = gpu_sample.unwrap_or_default();
  let (process_gpu_usage, adapter_usage) = engine_usage(&sample.engines);
  let process_dedicated = memory_by(&sample.process_dedicated, |instance| instance.pid);
  let process_shared = memory_by(&sample.process_shared, |instance| instance.pid);
  let adapter_dedicated = memory_by(&sample.adapter_dedicated, |instance| instance.luid.clone());
  let adapter_shared = memory_by(&sample.adapter_shared, |instance| instance.luid.clone());
  let gpus = dedupe_gpus(
    sample
      .adapters
      .iter()
      .map(|(luid, name, total)| GpuInfo {
        name: name.clone(),
        dedicated_total: *total,
        dedicated_used: adapter_dedicated.get(luid).copied(),
        shared_used: adapter_shared.get(luid).copied(),
        usage: adapter_usage.get(luid).copied(),
      })
      .collect(),
  );

  // 进程按名称合并
  let mut groups: HashMap<String, ProcessGroup> = HashMap::new();
  let mut members: HashMap<String, Vec<(f32, u64, u32)>> = HashMap::new();
  for (pid, process) in system.processes() {
    let pid = pid.as_u32();
    let name = process.name().to_string_lossy().trim_end_matches(".exe").to_string();
    if name.is_empty() {
      continue;
    }
    // sysinfo 在 Windows 上给出的已经是占整机 CPU 的百分比（不是占一个核心的），不用再除以核心数
    let cpu_share = process.cpu_usage();
    let disk = process.disk_usage();
    let group = groups.entry(name.clone()).or_insert_with(|| ProcessGroup { name: name.clone(), ..Default::default() });
    group.count += 1;
    group.cpu += cpu_share;
    group.memory += process.memory();
    group.gpu_memory += process_dedicated.get(&pid).copied().unwrap_or(0);
    group.gpu_shared_memory += process_shared.get(&pid).copied().unwrap_or(0);
    group.gpu_usage = (group.gpu_usage + process_gpu_usage.get(&pid).copied().unwrap_or(0.0)).min(100.0);
    group.disk_read_per_sec += per_sec(disk.read_bytes);
    group.disk_write_per_sec += per_sec(disk.written_bytes);
    members.entry(name).or_default().push((cpu_share, process.memory(), pid));
  }
  for (name, mut list) in members {
    list.sort_by(|a, b| b.0.total_cmp(&a.0).then(b.1.cmp(&a.1)));
    if let Some(group) = groups.get_mut(&name) {
      group.pids = list.iter().take(5).map(|(_, _, pid)| *pid).collect();
      group.cpu = group.cpu.min(100.0);
    }
  }

  let disks = Disks::new_with_refreshed_list()
    .map(|disks| {
      (&disks)
        .into_iter()
        .map(|disk| DiskInfo {
          mount: disk.mount_point().to_string_lossy().into_owned(),
          total: disk.total_space(),
          available: disk.available_space(),
        })
        .collect()
    })
    .unwrap_or_default();

  let mut network: Vec<NetworkInfo> = networks
    .as_ref()
    .map(|networks| {
      networks
        .into_iter()
        .map(|(name, data)| NetworkInfo {
          name: name.to_string_lossy().into_owned(),
          received_per_sec: per_sec(data.received()),
          sent_per_sec: per_sec(data.transmitted()),
        })
        .filter(|item| item.received_per_sec > 0 || item.sent_per_sec > 0)
        .collect()
    })
    .unwrap_or_default();
  network.sort_by_key(|item| std::cmp::Reverse(item.received_per_sec + item.sent_per_sec));

  Ok(SystemSnapshot {
    os: System::long_os_version().unwrap_or_default(),
    uptime_seconds: System::uptime().unwrap_or(0),
    sample_seconds: seconds,
    cpu,
    memory,
    gpus,
    disks,
    network,
    battery: battery(),
    process_count: system.processes().len(),
    processes: groups.into_values().collect(),
  })
}

#[cfg(windows)]
fn battery() -> Option<BatteryInfo> {
  use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

  let mut status = SYSTEM_POWER_STATUS { ACLineStatus: 0, BatteryFlag: 0, BatteryLifePercent: 0, SystemStatusFlag: 0, BatteryLifeTime: 0, BatteryFullLifeTime: 0 };
  if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
    return None;
  }
  // 128：没有电池（台式机）；255：无法获取
  if status.BatteryFlag & 128 != 0 || status.BatteryFlag == 255 {
    return None;
  }
  Some(BatteryInfo {
    percent: (status.BatteryLifePercent <= 100).then_some(status.BatteryLifePercent),
    plugged_in: status.ACLineStatus == 1,
    charging: status.BatteryFlag & 8 != 0,
    remaining_seconds: (status.BatteryLifeTime != u32::MAX).then_some(status.BatteryLifeTime),
    saver: status.SystemStatusFlag & 1 != 0,
  })
}

#[cfg(not(windows))]
fn battery() -> Option<BatteryInfo> {
  None
}

#[cfg(windows)]
mod gpu {
  use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
    PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_FMT_LARGE,
    PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
  };

  use super::GpuSample;

  fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
  }

  /// 显卡的 LUID、名称与独立显存总量（不含「Microsoft Basic Render Driver」这类软件渲染器）
  fn adapters() -> Vec<(String, String, u64)> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};

    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else { return vec![] };
    let mut result = Vec::new();
    let mut index = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
      index += 1;
      let Ok(desc) = (unsafe { adapter.GetDesc1() }) else { continue };
      if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
        continue;
      }
      let length = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
      let name = String::from_utf16_lossy(&desc.Description[..length]).trim().to_string();
      let luid = format!("0x{:08X}_0x{:08X}", desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart);
      // 同一块显卡可能出现多次（如多个输出），按 LUID 去重
      if !result.iter().any(|(existing, _, _): &(String, String, u64)| existing == &luid) {
        result.push((luid, name, desc.DedicatedVideoMemory as u64));
      }
    }
    result
  }

  pub struct Query {
    handle: PDH_HQUERY,
    engine: PDH_HCOUNTER,
    process_dedicated: PDH_HCOUNTER,
    process_shared: PDH_HCOUNTER,
    adapter_dedicated: PDH_HCOUNTER,
    adapter_shared: PDH_HCOUNTER,
  }

  // 查询只在采集它的线程中使用
  unsafe impl Send for Query {}

  impl Query {
    /// 打开 GPU 相关的计数器；系统没有这些计数器（如旧版本 Windows）时返回 None
    pub fn open() -> Option<Self> {
      let mut handle: PDH_HQUERY = std::ptr::null_mut();
      if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut handle) } != 0 {
        return None;
      }
      let add = |path: &str| {
        let mut counter: PDH_HCOUNTER = std::ptr::null_mut();
        let status = unsafe { PdhAddEnglishCounterW(handle, wide(path).as_ptr(), 0, &mut counter) };
        (status == 0).then_some(counter)
      };
      let query = (|| {
        Some(Query {
          handle,
          engine: add(r"\GPU Engine(*)\Utilization Percentage")?,
          process_dedicated: add(r"\GPU Process Memory(*)\Dedicated Usage")?,
          process_shared: add(r"\GPU Process Memory(*)\Shared Usage")?,
          adapter_dedicated: add(r"\GPU Adapter Memory(*)\Dedicated Usage")?,
          adapter_shared: add(r"\GPU Adapter Memory(*)\Shared Usage")?,
        })
      })();
      if query.is_none() {
        unsafe { PdhCloseQuery(handle) };
      }
      query
    }

    pub fn collect(&self) {
      unsafe { PdhCollectQueryData(self.handle) };
    }

    pub fn read(&self) -> GpuSample {
      GpuSample {
        adapters: adapters(),
        engines: values(self.engine, PDH_FMT_DOUBLE, |value| unsafe { value.doubleValue }),
        process_dedicated: values(self.process_dedicated, PDH_FMT_LARGE, |value| unsafe { value.largeValue }),
        process_shared: values(self.process_shared, PDH_FMT_LARGE, |value| unsafe { value.largeValue }),
        adapter_dedicated: values(self.adapter_dedicated, PDH_FMT_LARGE, |value| unsafe { value.largeValue }),
        adapter_shared: values(self.adapter_shared, PDH_FMT_LARGE, |value| unsafe { value.largeValue }),
      }
    }
  }

  impl Drop for Query {
    fn drop(&mut self) {
      unsafe { PdhCloseQuery(self.handle) };
    }
  }

  /// 以 0 结尾的 UTF-16 字符串
  unsafe fn wide_to_string(text: *const u16) -> Option<String> {
    if text.is_null() {
      return None;
    }
    let mut length = 0;
    while unsafe { *text.add(length) } != 0 {
      length += 1;
    }
    Some(String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) }))
  }

  /// 读取通配计数器（*）的所有实例：实例名与数值
  fn values<T>(
    counter: PDH_HCOUNTER,
    format: PDH_FMT,
    read: impl Fn(&windows_sys::Win32::System::Performance::PDH_FMT_COUNTERVALUE_0) -> T,
  ) -> Vec<(String, T)> {
    let mut size = 0u32;
    let mut count = 0u32;
    let status = unsafe { PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, std::ptr::null_mut()) };
    if status != PDH_MORE_DATA || size == 0 {
      return vec![];
    }
    // 按 8 字节对齐分配（结构体中有 f64 / i64）
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    let items = buffer.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>();
    if unsafe { PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, items) } != 0 {
      return vec![];
    }
    (0..count as usize)
      .filter_map(|index| {
        let item = unsafe { &*items.add(index) };
        if item.FmtValue.CStatus != PDH_CSTATUS_VALID_DATA && item.FmtValue.CStatus != PDH_CSTATUS_NEW_DATA {
          return None;
        }
        Some((unsafe { wide_to_string(item.szName) }?, read(&item.FmtValue.Anonymous)))
      })
      .collect()
  }
}

#[cfg(not(windows))]
mod gpu {
  use super::GpuSample;

  pub struct Query;

  impl Query {
    pub fn open() -> Option<Self> {
      None
    }
    pub fn collect(&self) {}
    pub fn read(&self) -> GpuSample {
      GpuSample::default()
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{dedupe_gpus, engine_usage, memory_by, parse_gpu_instance, GpuInfo, GpuInstance};

  #[test]
  fn drops_duplicate_gpus_without_data() {
    let gpu = |name: &str, used: Option<u64>| GpuInfo { name: name.into(), dedicated_used: used, ..Default::default() };
    let gpus = dedupe_gpus(vec![gpu("RTX", Some(1)), gpu("Intel", None), gpu("RTX", None)]);
    assert_eq!(gpus.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["RTX", "Intel"]);
  }

  #[test]
  fn parses_gpu_counter_instances() {
    assert_eq!(
      parse_gpu_instance("pid_1234_luid_0x00000000_0x0000d1a3_phys_0_eng_0_engtype_3D"),
      GpuInstance { pid: Some(1234), luid: Some("0x00000000_0x0000D1A3".into()), engine_type: Some("3D".into()) },
    );
    assert_eq!(
      parse_gpu_instance("luid_0x00000000_0x0000D1A3_phys_0"),
      GpuInstance { pid: None, luid: Some("0x00000000_0x0000D1A3".into()), engine_type: None },
    );
  }

  #[test]
  fn sums_engines_by_type_then_takes_the_busiest() {
    let luid = "luid_0x00000000_0x0000AAAA_phys_0";
    let items = vec![
      (format!("pid_1_{luid}_eng_0_engtype_3D"), 30.0),
      (format!("pid_1_{luid}_eng_1_engtype_3D"), 15.0),
      (format!("pid_1_{luid}_eng_2_engtype_VideoDecode"), 20.0),
      (format!("pid_2_{luid}_eng_0_engtype_3D"), 40.0),
    ];
    let (process, adapter) = engine_usage(&items);
    assert_eq!(process[&1], 45.0);
    assert_eq!(process[&2], 40.0);
    // 3D 引擎合计 85%，高于视频解码的 20%
    assert_eq!(adapter["0x00000000_0x0000AAAA"], 85.0);
  }

  #[test]
  fn sums_memory_by_process_and_adapter() {
    let items = vec![
      ("pid_7_luid_0x00000000_0x0000AAAA_phys_0".to_string(), 100),
      ("pid_7_luid_0x00000000_0x0000BBBB_phys_0".to_string(), 50),
      ("pid_8_luid_0x00000000_0x0000AAAA_phys_0".to_string(), -1),
    ];
    let by_pid = memory_by(&items, |instance| instance.pid);
    assert_eq!(by_pid[&7], 150);
    assert_eq!(by_pid[&8], 0);
    let by_luid = memory_by(&items, |instance| instance.luid.clone());
    assert_eq!(by_luid["0x00000000_0x0000AAAA"], 100);
  }
}
