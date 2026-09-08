//! Unified kernel output protocol shared by every format kernel.
//!
//! Members and messages use one superset struct each (fields the format does
//! not produce stay `None`); the format-specific meta travels as a JSON string
//! so adding formats never changes the N-API surface.

#[cfg(feature = "napi")]
use napi_derive::napi;
use serde::Serialize;

#[cfg(feature = "napi")]
#[cfg_attr(feature = "napi", napi(object))]
pub struct NativeParseProgress {
    pub bytes_read: f64,
    pub total_bytes: f64,
    pub messages_processed: f64,
}

#[cfg_attr(feature = "napi", napi(object))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMemberRole {
    pub id: String,
    /// Present only when the source role object had a `name` key.
    pub name: Option<String>,
}

#[cfg_attr(feature = "napi", napi(object))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMember {
    pub platform_id: String,
    pub account_name: String,
    pub group_nickname: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub avatar: Option<String>,
    pub roles: Option<Vec<NativeMemberRole>>,
}

#[cfg_attr(feature = "napi", napi(object))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAttachment {
    /// One of image / video / audio / file / sticker.
    pub kind: String,
    /// Relative to the export file's directory, an absolute path, or an http(s) URL.
    pub path: String,
    pub name: Option<String>,
    pub mime_type: Option<String>,
    pub size: Option<f64>,
    pub duration_ms: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[cfg_attr(feature = "napi", napi(object))]
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMessage {
    pub platform_message_id: Option<String>,
    pub sender_platform_id: String,
    pub sender_account_name: String,
    pub sender_group_nickname: Option<String>,
    /// None when the source timestamp was JSON null (importer skips those).
    pub timestamp: Option<f64>,
    /// Numeric MessageType enum value from shared-types.
    pub message_type: u32,
    pub content: Option<String>,
    pub reply_to_message_id: Option<String>,
    /// None when the message carried no usable attachment.
    pub attachments: Option<Vec<NativeAttachment>>,
}

/// What a format kernel returns: meta as format-specific JSON plus unified
/// member/message structs, pumped to JS through the shared `NativeParser`.
pub struct KernelOutput {
    pub meta_json: String,
    pub members: Vec<NativeMember>,
    pub messages: Vec<NativeMessage>,
}
