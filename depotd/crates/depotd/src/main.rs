//! depotd：Agent Depot 纯 Rust 后端（axum 全路由 + SSE + 静态）。
mod migrate_cmd;
mod routes;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use clap::Parser;
use depot_watch::Watcher;

#[derive(Parser)]
#[command(name = "depotd", version, about = "Agent Depot 纯 Rust 后端")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
    /// HTTP 端口
    #[arg(long, default_value = "8317")]
    port: u16,
    /// 前端静态目录覆盖（默认 <hub>/web 或 ./web）
    #[arg(long)]
    web_dir: Option<String>,
}

#[derive(clap::Subcommand)]
enum Cmd {
    /// 版本信息（零文件系统副作用）
    Version,
    /// 数据库健康检查
    Doctor,
    /// legacy hub.db 迁移（六 Phase：预检→quiesce→建库→搬数据→重算→adopt+verify）
    Migrate {
        #[arg(long)]
        legacy: String,
        /// 迁移后不自动 adopt（人工核对）
        #[arg(long)]
        no_adopt: bool,
    },
    /// 启动 HTTP 服务
    Serve,
}

pub struct AppState {
    pub store: depot_core::Store,
    pub build: &'static str,
    pub watcher: Arc<Watcher>,
    pub web_dir: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
    match cli.cmd {
        Some(Cmd::Version) => {
            println!("depotd {}", env!("CARGO_PKG_VERSION"));
        }
        Some(Cmd::Doctor) => {
            let hub = depot_core::paths::hub_dir();
            println!("hub_dir: {}", hub.display());
            let db = hub.join("depot.db");
            if db.exists() {
                let st = depot_core::Store::open(&db, 1)?;
                let _ = st.checkpoint();
                println!("db: OK ({})", db.display());
            } else {
                println!("db: 未创建");
            }
        }
        Some(Cmd::Migrate { legacy, no_adopt }) => {
            migrate_cmd::run(&legacy, !no_adopt)?;
        }
        Some(Cmd::Serve) | None => {
            let hub = depot_core::paths::hub_dir();
            let db_path = hub.join("depot.db");
            let store = depot_core::Store::open(&db_path, 4)?;
            let watcher = Watcher::new();
            watcher.set_roots(&watch_roots(&store, &hub));
            watcher.start_polling();
            // web 静态目录：<仓>/web 优先（开发态），其次 hub/web
            let web_dir = cli.web_dir.clone().or_else(|| {
                let cand = std::path::Path::new("web");
                if cand.join("index.html").exists() {
                    Some(cand.to_string_lossy().to_string())
                } else {
                    None
                }
            });
            let state = Arc::new(AppState {
                store,
                build: env!("CARGO_PKG_VERSION"),
                watcher,
                web_dir,
            });
            let app = routes::router(state.clone());
            let addr = SocketAddr::from(([127, 0, 0, 1], cli.port));
            println!("depotd {} · http://{addr}", env!("CARGO_PKG_VERSION"));
            let listener = tokio::net::TcpListener::bind(addr).await?;
            axum::serve(listener, app).await?;
        }
    }
    Ok(())
}

/// 监控范围（watch_roots 对位）：{scope: [路径]}。
fn watch_roots(store: &depot_core::Store, hub: &std::path::Path) -> HashMap<String, Vec<std::path::PathBuf>> {
    let mut roots: HashMap<String, Vec<std::path::PathBuf>> = HashMap::new();
    let tools_list = {
        let rc_ = store.read_conn();
        let c_ = rc_.lock().unwrap();
        depot_core::tools::load_tools(&c_)
    };
    for t in tools_list {
        let tid = match t["id"].as_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let mut paths = Vec::new();
        if let Some(r) = t.get("root").and_then(|v| v.as_str()) {
            paths.push(depot_core::tools::shellexpand(r));
        }
        if let Some(sd) = t.get("skills_dir").and_then(|v| v.as_str()) {
            paths.push(depot_core::tools::shellexpand(sd));
        }
        if !paths.is_empty() {
            roots.insert(format!("tool:{tid}"), paths);
        }
    }
    let layouts = depot_memory::layouts();
    if let Some(o) = layouts.as_object() {
        for (tid, lay) in o {
            let mut paths = Vec::new();
            for k in ["global", "projects_dir"] {
                if let Some(p) = lay.get(k).and_then(|v| v.as_str()) {
                    paths.push(depot_core::tools::shellexpand(p));
                }
            }
            if !paths.is_empty() {
                roots.insert(format!("memory:{tid}"), paths);
            }
        }
    }
    roots.insert(
        "memory:hub".into(),
        vec![depot_memory::memstore_root()],
    );
    roots.insert("hub:sources".into(), vec![hub.join("sources")]);
    roots.insert("hub:registry".into(), vec![hub.join("registry")]);
    // 本地目录（链接的 hub 外路径）
    let conn = store.read_conn();
    let c = conn.lock().unwrap();
    let linked: Vec<std::path::PathBuf> = match c
        .prepare("SELECT path FROM local_dirs WHERE origin='linked'")
    {
        Ok(mut stmt) => stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map(|rows| {
                rows.filter_map(|r| r.ok())
                    .map(std::path::PathBuf::from)
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => vec![],
    };
    if !linked.is_empty() {
        roots.insert("hub:localdirs".into(), linked);
    }
    roots
}
