//! 类型化错误：稳定 `code` 是 Tier 1 契约（只增不改不删，前端未知 code 回退 message）。

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    NameInvalid,
    NameTraversal,
    NotFound,
    AlreadyExists,
    ConflictLocalModified,
    ConflictUnmanaged,
    ConflictDrift,
    ModuleDisabled,
    BadRequest,
    SourceMissing,
    TargetBusy,
    DbBusy,
    Io,
    Timeout,
    Internal,
}

impl Code {
    pub fn as_str(&self) -> &'static str {
        match self {
            Code::NameInvalid => "NAME_INVALID",
            Code::NameTraversal => "NAME_TRAVERSAL",
            Code::NotFound => "NOT_FOUND",
            Code::AlreadyExists => "ALREADY_EXISTS",
            Code::ConflictLocalModified => "CONFLICT_LOCAL_MODIFIED",
            Code::ConflictUnmanaged => "CONFLICT_UNMANAGED",
            Code::ConflictDrift => "CONFLICT_DRIFT",
            Code::ModuleDisabled => "MODULE_DISABLED",
            Code::BadRequest => "BAD_REQUEST",
            Code::SourceMissing => "SOURCE_MISSING",
            Code::TargetBusy => "TARGET_BUSY",
            Code::DbBusy => "DB_BUSY",
            Code::Io => "IO",
            Code::Timeout => "TIMEOUT",
            Code::Internal => "INTERNAL",
        }
    }
}

/// 领域/基础设施统一错误：`code` 稳定、`message` 人类可读（中文文案自由）。
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct CoreError {
    pub code: Code,
    pub message: String,
    #[source]
    pub source: Option<anyhow::Error>,
}

impl CoreError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), source: None }
    }

    pub fn with_source(code: Code, message: impl Into<String>, src: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self { code, message: message.into(), source: Some(anyhow::Error::new(src)) }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(Code::BadRequest, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(Code::NotFound, message)
    }
    pub fn io(message: impl Into<String>, src: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::with_source(Code::Io, message, src)
    }
}

impl From<rusqlite::Error> for CoreError {
    fn from(e: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode::*;
        let code = match e.sqlite_error_code() {
            Some(code) => match code {
                DatabaseBusy | DatabaseLocked => Code::DbBusy,
                ConstraintViolation => Code::AlreadyExists,
                _ => Code::Internal,
            },
            None => Code::Internal,
        };
        Self { code, message: e.to_string(), source: Some(anyhow::Error::new(e)) }
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        Self { code: Code::Io, message: e.to_string(), source: Some(anyhow::Error::new(e)) }
    }
}

/// 便捷别名。
pub type Result<T> = std::result::Result<T, CoreError>;

/// 结构化错误输出（HTTP 层转 JSON；detail 截断 ≤200 为既有契约）。
pub struct ErrorBody {
    pub status: u16,
    pub body: serde_json::Value,
}

impl CoreError {
    pub fn status(&self) -> u16 {
        match self.code {
            Code::NotFound => 404,
            Code::BadRequest | Code::NameInvalid | Code::NameTraversal => 400,
            Code::ModuleDisabled => 503,
            Code::DbBusy | Code::Timeout => 503,
            _ => 500,
        }
    }

    pub fn to_body(&self) -> ErrorBody {
        let message: String = self.message.chars().take(200).collect();
        ErrorBody {
            status: self.status(),
            body: serde_json::json!({
                "ok": false,
                "code": self.code.as_str(),
                "error": message,
            }),
        }
    }
}

impl fmt::Display for Code {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
