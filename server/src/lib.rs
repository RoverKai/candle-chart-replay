//! 本地 K 线复盘服务端（Rust 版）。
//!
//! 对外契约与旧 Python 版本一致：
//! `GET /api/catalog`、`/api/bars`、`/api/refresh`、`/api/health`，
//! 其余路径由 `web/` 静态资源提供。

pub mod api;
pub mod cache;
pub mod catalog;
pub mod config;
pub mod hst;
