//! depot-core：存储、文件原语、路径、事件日志（Rust 重写的基础层）。
//!
//! 契约来源：`Plans/Rust化-v3-最优架构.md` §五（四路评审修订）与
//! `tests/fixtures/golden/hashes.json` 黄金样本（tree hash 算法定义升格为规格；判据 crates/depotd/tests/spec_hash.rs）。

pub mod error;
pub mod gitsrc;
pub mod mcputil;
pub mod events;
pub mod fsutil;
pub mod paths;
pub mod store;
pub mod tools;
pub mod zipstore;

pub use error::{CoreError, Code};
pub use store::Store;
