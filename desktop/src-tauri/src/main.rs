#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::process::Command;
use std::time::Duration;

const DEFAULT_REPO: &str = "/Users/planarcat/Documents/Projects/@planarcat/agent-depot";
const CONSOLE_URL: &str = "http://127.0.0.1:8317";
const PORT: u16 = 8317;

fn repo_dir() -> String {
    std::env::var("AGENT_DEPOT_REPO").unwrap_or_else(|_| DEFAULT_REPO.to_string())
}

fn service_up() -> bool {
    match format!("127.0.0.1:{PORT}").parse() {
        Ok(addr) => TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok(),
        Err(_) => false,
    }
}

/// 与薄壳一致的语义：双击 = 确保本地服务在跑，然后打开控制台窗口。
fn ensure_service() -> bool {
    if service_up() {
        return true;
    }
    let script = format!("cd '{}' && ./run.sh", repo_dir());
    let _ = Command::new("bash").arg("-c").arg(&script).status();
    for _ in 0..24 {
        if service_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    service_up()
}

fn main() {
    let up = ensure_service();
    tauri::Builder::default()
        .setup(move |app| {
            let url = if up {
                tauri::WebviewUrl::External(CONSOLE_URL.parse().expect("valid console url"))
            } else {
                tauri::WebviewUrl::App("index.html".into())
            };
            tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("Agent Depot")
                .inner_size(1480.0, 960.0)
                .min_inner_size(960.0, 640.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
