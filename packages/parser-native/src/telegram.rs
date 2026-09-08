//! Telegram official JSON export kernel (full export and single-chat export).
//!
//! Replicates `packages/parser/src/formats/telegram-native.ts` (full export,
//! one chat selected by `chatIndex`) and
//! `packages/parser/src/formats/telegram-native-single.ts` (single-chat
//! export), both of which share `formats/utils/telegram-utils.ts`. The TS
//! implementations are the reference: any semantic difference is a bug
//! (covered by TS-side parity tests).
//!
//! Fields whose TS path would take a non-string branch (e.g. a numeric
//! `from_id`, on which the TS parser calls `String.prototype.replace`) make the
//! kernel bail out with an error, which the callers turn into a TS re-parse.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use crate::input::KernelInput;
use crate::jsutil::truthy_str;
use crate::protocol::{KernelOutput, NativeAttachment, NativeMember, NativeMessage};
use crate::scanner::{for_each_array_element, scan_error, walk_top_level, ScanError, ScanResult};

/// Sender name for a service message without an `actor`. The two TS parsers
/// disagree here (`telegram-native.ts` uses '系统', `telegram-native-single.ts`
/// uses 'System'), so each mode keeps its own reference value.
const SERVICE_SENDER_MULTI: &str = "系统";
const SERVICE_SENDER_SINGLE: &str = "System";

/// Shape of `metaJson()` for the telegram kernel (consumed by the TS adapter).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelegramMeta {
    name: String,
    /// "group" | "private" — matches the ChatType enum string values.
    chat_type: &'static str,
    group_id: Option<String>,
    /// Index inside `chats.list`; null for a single-chat export.
    chat_index: Option<u32>,
}

struct TelegramOptions {
    chat_index: u32,
    single: bool,
}

/// `chatIndex` (default 0) and `single` from the JS `formatOptions` blob.
fn parse_options(options_json: Option<&str>) -> ScanResult<TelegramOptions> {
    let mut options = TelegramOptions {
        chat_index: 0,
        single: false,
    };
    let Some(raw) = options_json else {
        return Ok(options);
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return Ok(options);
    };

    options.single = matches!(map.get("single"), Some(Value::Bool(true)));
    options.chat_index = match map.get("chatIndex") {
        None | Some(Value::Null) => 0,
        Some(Value::Number(number)) => match number.as_u64() {
            Some(index) if index <= u32::MAX as u64 => index as u32,
            _ => return Err(scan_error("unsupported chatIndex option", 0)),
        },
        Some(_) => return Err(scan_error("unsupported chatIndex option", 0)),
    };
    Ok(options)
}

// ==================== JavaScript value helpers ====================

/// `String(value)` for the id-like fields the TS parsers stringify.
fn js_string(value: Option<&Value>) -> ScanResult<String> {
    Ok(match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(_) => return Err(scan_error("unsupported id value", 0)),
    })
}

/// JavaScript truthiness of any JSON value.
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Number.parseInt(value, 10)`; None when the result would be NaN.
fn js_parse_int(value: Option<&Value>) -> ScanResult<Option<f64>> {
    let owned;
    let text = match value {
        Some(Value::String(text)) => text.as_str(),
        Some(Value::Number(number)) => {
            owned = number.to_string();
            owned.as_str()
        }
        _ => return Ok(None),
    };

    let trimmed = crate::jsutil::js_trim(text);
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return Ok(None);
    }
    let parsed: f64 = digits[..end]
        .parse()
        .map_err(|_| scan_error("unsupported date_unixtime value", 0))?;
    Ok(Some(sign * parsed))
}

// ==================== telegram-utils.ts replication ====================

/// `mapChatType`: only the three one-to-one chat kinds are private; every
/// other value (groups, channels, unknown, missing) falls through to group.
fn map_chat_type(telegram_type: Option<&Value>) -> &'static str {
    match telegram_type {
        Some(Value::String(value))
            if matches!(
                value.as_str(),
                "personal_chat" | "bot_chat" | "saved_messages"
            ) =>
        {
            "private"
        }
        _ => "group",
    }
}

/// `from_id` / `actor_id` → platform id: drop one leading "user"/"channel".
fn extract_platform_id(value: Option<&Value>) -> ScanResult<String> {
    let Some(raw) = truthy_str(value)? else {
        return Ok("unknown".to_string());
    };
    let stripped = raw
        .strip_prefix("user")
        .or_else(|| raw.strip_prefix("channel"))
        .unwrap_or(raw);
    Ok(stripped.to_string())
}

/// `extractText`: a plain string, or the concatenated parts of a rich-text array.
fn extract_text(value: Option<&Value>) -> ScanResult<String> {
    match value {
        Some(Value::String(text)) => Ok(text.clone()),
        Some(Value::Array(parts)) => {
            let mut text = String::new();
            for part in parts {
                match part {
                    Value::String(part) => text.push_str(part),
                    Value::Object(part) => match part.get("text") {
                        None | Some(Value::Null) => {}
                        Some(Value::String(part)) => text.push_str(part),
                        Some(_) => return Err(scan_error("unsupported rich text part", 0)),
                    },
                    _ => {}
                }
            }
            Ok(text)
        }
        _ => Ok(String::new()),
    }
}

/// `msg.members?.join(', ') || ''` for service messages.
fn join_members(value: Option<&Value>) -> ScanResult<String> {
    match value {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::Array(items)) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    Value::String(item) => parts.push(item.as_str()),
                    Value::Null => parts.push(""),
                    _ => return Err(scan_error("unsupported service member entry", 0)),
                }
            }
            Ok(parts.join(", "))
        }
        Some(_) => Err(scan_error("unsupported service members value", 0)),
    }
}

/// Fields of one message that both `detectMessageType` and `buildContent` read.
struct MediaFields<'a> {
    media_type: Option<&'a str>,
    photo: Option<&'a str>,
    file: Option<&'a str>,
}

/// Branch order matters and follows `detectMessageType` exactly.
fn detect_message_type(media: &MediaFields<'_>, is_service: bool) -> u32 {
    if is_service {
        return 80; // SYSTEM
    }
    if media.media_type == Some("sticker") || media.photo.is_some() {
        return 1; // IMAGE
    }
    match media.media_type {
        Some("animation") => 1,                          // IMAGE
        Some("video_file") | Some("video_message") => 3, // VIDEO
        Some("voice_message") => 2,                      // VOICE
        None if media.file.is_some() => 4,               // FILE
        _ => 0,                                          // TEXT
    }
}

fn build_content(
    obj: &serde_json::Map<String, Value>,
    media: &MediaFields<'_>,
    is_service: bool,
) -> ScanResult<Option<String>> {
    let text = extract_text(obj.get("text"))?;
    let or_null = |text: String| (!text.is_empty()).then_some(text);

    if is_service {
        let action = truthy_str(obj.get("action"))?.unwrap_or("");
        let members = join_members(obj.get("members"))?;
        if !members.is_empty() {
            return Ok(Some(format!("[{action}] {members}")));
        }
        if !action.is_empty() {
            return Ok(Some(format!("[{action}]")));
        }
        return Ok(or_null(text));
    }

    if media.media_type == Some("sticker") {
        if let Some(emoji) = truthy_str(obj.get("sticker_emoji"))? {
            return Ok(Some(if text.is_empty() {
                format!("[sticker {emoji}]")
            } else {
                format!("[sticker {emoji}] {text}")
            }));
        }
    }

    if media.photo.is_some() || media.file.is_some() || media.media_type.is_some() {
        let label = media.media_type.unwrap_or(if media.photo.is_some() {
            "photo"
        } else {
            "file"
        });
        return Ok(Some(if text.is_empty() {
            format!("[{label}]")
        } else {
            format!("[{label}] {text}")
        }));
    }

    Ok(or_null(text))
}

/// `duration_seconds * 1000`; a present-but-null value multiplies to 0 in JS.
fn duration_ms(value: Option<&Value>) -> ScanResult<Option<f64>> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(0.0)),
        Some(Value::Number(number)) => Ok(number.as_f64().map(|seconds| seconds * 1000.0)),
        Some(_) => Err(scan_error("unsupported duration_seconds value", 0)),
    }
}

fn optional_number(value: Option<&Value>) -> ScanResult<Option<f64>> {
    match value {
        None => Ok(None),
        Some(Value::Number(number)) => Ok(number.as_f64()),
        Some(_) => Err(scan_error("unsupported numeric field", 0)),
    }
}

fn build_attachments(
    obj: &serde_json::Map<String, Value>,
    media: &MediaFields<'_>,
) -> ScanResult<Option<Vec<NativeAttachment>>> {
    let Some(path) = media.file.or(media.photo) else {
        return Ok(None);
    };
    let kind = match media.file {
        None => "image",
        Some(_) => match media.media_type {
            Some("video_file") | Some("video_message") => "video",
            Some("voice_message") | Some("audio_file") => "audio",
            Some("sticker") => "sticker",
            Some("animation") => "image",
            _ => "file",
        },
    };

    Ok(Some(vec![NativeAttachment {
        kind: kind.to_string(),
        path: path.to_string(),
        name: truthy_str(obj.get("file_name"))?.map(str::to_string),
        mime_type: truthy_str(obj.get("mime_type"))?.map(str::to_string),
        size: None,
        duration_ms: duration_ms(obj.get("duration_seconds"))?,
        width: optional_number(obj.get("width"))?,
        height: optional_number(obj.get("height"))?,
    }]))
}

// ==================== Chat parsing ====================

struct MemberTracker {
    order: Vec<NativeMember>,
    seen: HashSet<String>,
}

impl MemberTracker {
    fn new() -> Self {
        MemberTracker {
            order: Vec::new(),
            seen: HashSet::new(),
        }
    }

    /// First display name wins (the TS parsers only insert unseen ids).
    fn observe(&mut self, platform_id: &str, account_name: &str) {
        if platform_id == "unknown" || !self.seen.insert(platform_id.to_string()) {
            return;
        }
        self.order.push(NativeMember {
            platform_id: platform_id.to_string(),
            account_name: account_name.to_string(),
            group_nickname: None,
            aliases: None,
            avatar: None,
            roles: None,
        });
    }
}

/// The four chat-level keys both export shapes carry.
struct ChatSpans<'a> {
    header: HashMap<&'static str, Value>,
    messages: Option<&'a [u8]>,
}

fn collect_chat_spans(buf: &[u8]) -> ScanResult<ChatSpans<'_>> {
    let mut spans = ChatSpans {
        header: HashMap::new(),
        messages: None,
    };
    let mut header_error: Option<ScanError> = None;

    walk_top_level(buf, |key, raw| {
        let field = match key {
            b"name" => "name",
            b"type" => "type",
            b"id" => "id",
            b"messages" => {
                spans.messages = Some(raw);
                return Ok(());
            }
            _ => return Ok(()),
        };
        match serde_json::from_slice::<Value>(raw) {
            Ok(value) => {
                spans.header.insert(field, value);
            }
            Err(error) => {
                header_error = Some(scan_error(format!("invalid chat {field}: {error}"), 0));
            }
        }
        Ok(())
    })?;

    match header_error {
        Some(error) => Err(error),
        None => Ok(spans),
    }
}

fn parse_chat(
    buf: &[u8],
    spans: &ChatSpans<'_>,
    chat_index: Option<u32>,
    service_sender: &str,
    mut on_progress: impl FnMut(u64, u64),
) -> ScanResult<KernelOutput> {
    let chat_type = map_chat_type(spans.header.get("type"));
    let chat_id = js_string(spans.header.get("id"))?;
    let name = match truthy_str(spans.header.get("name"))? {
        Some(name) => name.to_string(),
        None => format!("Telegram Chat {chat_id}"),
    };
    let group_id = (chat_type == "group").then_some(chat_id);

    let mut members = MemberTracker::new();
    let mut messages: Vec<NativeMessage> = Vec::new();

    if let Some(raw) = spans.messages {
        let base_offset = raw.as_ptr() as usize - buf.as_ptr() as usize;
        for_each_array_element(raw, base_offset, |element, end_offset| {
            let element_offset = end_offset.saturating_sub(element.len());
            let value: Value = serde_json::from_slice(element)
                .map_err(|error| scan_error(format!("invalid message: {error}"), element_offset))?;
            // A non-object element yields no timestamp in the TS parsers, which
            // skip it without recording a member.
            let Some(obj) = value.as_object() else {
                return Ok(());
            };

            let is_service =
                matches!(obj.get("type"), Some(Value::String(kind)) if kind == "service");
            let (sender_platform_id, sender_account_name) = if is_service {
                let id = extract_platform_id(obj.get("actor_id"))
                    .map_err(|error| scan_error(error.message, element_offset))?;
                let name = truthy_str(obj.get("actor"))
                    .map_err(|error| scan_error(error.message, element_offset))?
                    .unwrap_or(service_sender)
                    .to_string();
                (id, name)
            } else {
                let id = extract_platform_id(obj.get("from_id"))
                    .map_err(|error| scan_error(error.message, element_offset))?;
                let name = truthy_str(obj.get("from"))
                    .map_err(|error| scan_error(error.message, element_offset))?
                    .unwrap_or(&id)
                    .to_string();
                (id, name)
            };
            members.observe(&sender_platform_id, &sender_account_name);

            let timestamp = js_parse_int(obj.get("date_unixtime"))
                .map_err(|error| scan_error(error.message, element_offset))?;
            let Some(timestamp) = timestamp else {
                return Ok(());
            };

            let media = MediaFields {
                media_type: truthy_str(obj.get("media_type"))
                    .map_err(|error| scan_error(error.message, element_offset))?,
                photo: truthy_str(obj.get("photo"))
                    .map_err(|error| scan_error(error.message, element_offset))?,
                file: truthy_str(obj.get("file"))
                    .map_err(|error| scan_error(error.message, element_offset))?,
            };
            let reply_to = is_truthy(obj.get("reply_to_message_id"))
                .then(|| js_string(obj.get("reply_to_message_id")))
                .transpose()
                .map_err(|error| scan_error(error.message, element_offset))?;

            messages.push(NativeMessage {
                platform_message_id: Some(
                    js_string(obj.get("id"))
                        .map_err(|error| scan_error(error.message, element_offset))?,
                ),
                sender_platform_id,
                sender_account_name,
                sender_group_nickname: None,
                timestamp: Some(timestamp),
                message_type: detect_message_type(&media, is_service),
                content: build_content(obj, &media, is_service)
                    .map_err(|error| scan_error(error.message, element_offset))?,
                reply_to_message_id: reply_to,
                attachments: build_attachments(obj, &media)
                    .map_err(|error| scan_error(error.message, element_offset))?,
            });

            on_progress(end_offset as u64, messages.len() as u64);
            Ok(())
        })?;
    }

    let meta_json = serde_json::to_string(&TelegramMeta {
        name,
        chat_type,
        group_id,
        chat_index,
    })
    .map_err(|error| scan_error(format!("meta serialization failed: {error}"), 0))?;

    Ok(KernelOutput {
        meta_json,
        members: members.order,
        messages,
    })
}

pub fn parse_telegram(
    buf: &[u8],
    input: &KernelInput,
    on_progress: impl FnMut(u64, u64),
) -> ScanResult<KernelOutput> {
    let options = parse_options(input.options_json.as_deref())?;
    if options.single {
        let spans = collect_chat_spans(buf)?;
        return parse_chat(buf, &spans, None, SERVICE_SENDER_SINGLE, on_progress);
    }

    // Full export: chats.list[chatIndex]. Non-target chats are skimmed by the
    // scanner and never materialized.
    let mut chats_raw: Option<&[u8]> = None;
    walk_top_level(buf, |key, raw| {
        if key == b"chats" {
            chats_raw = Some(raw);
        }
        Ok(())
    })?;
    let chats_raw = chats_raw.ok_or_else(|| scan_error("missing chats object", 0))?;

    let mut list_raw: Option<&[u8]> = None;
    walk_top_level(chats_raw, |key, raw| {
        if key == b"list" {
            list_raw = Some(raw);
        }
        Ok(())
    })?;
    let list_raw = list_raw.ok_or_else(|| scan_error("missing chats.list array", 0))?;

    let mut target: Option<&[u8]> = None;
    let mut index: u32 = 0;
    let base_offset = list_raw.as_ptr() as usize - buf.as_ptr() as usize;
    for_each_array_element(list_raw, base_offset, |element, _| {
        if index == options.chat_index {
            target = Some(element);
        }
        index = index.saturating_add(1);
        Ok(())
    })?;

    let target = target.ok_or_else(|| {
        scan_error(
            format!("chat index {} not found in chats.list", options.chat_index),
            base_offset,
        )
    })?;
    let spans = collect_chat_spans(target)?;
    parse_chat(
        buf,
        &spans,
        Some(options.chat_index),
        SERVICE_SENDER_MULTI,
        on_progress,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(doc: &str, options_json: Option<&str>) -> KernelOutput {
        let input = KernelInput {
            primary_path: "/tmp/telegram.json".to_string(),
            options_json: options_json.map(str::to_string),
        };
        parse_telegram(doc.as_bytes(), &input, |_, _| {}).expect("parse should succeed")
    }

    fn meta(out: &KernelOutput) -> Value {
        serde_json::from_str(&out.meta_json).expect("meta_json should be valid JSON")
    }

    const FULL_EXPORT: &str = r#"{
      "about": "Telegram export",
      "chats": {
        "about": "chats",
        "list": [
          {"name": "干扰 A", "type": "personal_chat", "id": 11,
           "messages": [{"id": 1, "type": "message", "date_unixtime": "100", "from": "Noise", "from_id": "user1", "text": "skip me"}]},
          {"name": "目标群", "type": "private_supergroup", "id": -1001,
           "messages": [
             {"id": 7, "type": "message", "date_unixtime": "1704164645", "from": "Alice", "from_id": "user10001", "text": "hello telegram"},
             {"id": 8, "type": "message", "date_unixtime": "1704164700", "from": "Alice", "from_id": "user10001",
              "text": ["前缀 ", {"type": "bold", "text": "重点"}, 5, {"type": "link"}, "尾巴"], "reply_to_message_id": 7},
             {"id": 9, "type": "service", "date_unixtime": "1704164710", "actor": "Alice", "actor_id": "user10001",
              "action": "invite_members", "members": ["Bob", "Carol"], "text": ""},
             {"id": 10, "type": "message", "date_unixtime": "1704164720", "from_id": "channel99", "text": "no from"},
             {"id": 11, "type": "message", "date_unixtime": "not-a-number", "from": "Ghost", "from_id": "user777", "text": "dropped"}
           ]},
          {"name": "干扰 B", "type": "personal_chat", "id": 13, "messages": []}
        ]
      }
    }"#;

    #[test]
    fn selects_the_target_chat_and_skips_the_others() {
        let out = parse(FULL_EXPORT, Some(r#"{"chatIndex":1}"#));
        let target = meta(&out);
        assert_eq!(target["name"], "目标群");
        assert_eq!(target["chatType"], "group");
        assert_eq!(target["groupId"], "-1001");
        assert_eq!(target["chatIndex"], 1);
        assert_eq!(out.messages.len(), 4);
        assert_eq!(out.messages[0].content.as_deref(), Some("hello telegram"));
        assert_eq!(out.messages[0].platform_message_id.as_deref(), Some("7"));
        assert_eq!(out.messages[0].timestamp, Some(1704164645.0));

        // chatIndex defaults to 0 and picks the first chat instead.
        let first = parse(FULL_EXPORT, None);
        assert_eq!(meta(&first)["name"], "干扰 A");
        assert_eq!(meta(&first)["chatType"], "private");
        assert_eq!(meta(&first)["groupId"], Value::Null);
        assert_eq!(first.messages.len(), 1);
    }

    #[test]
    fn concatenates_rich_text_arrays_and_keeps_reply_ids() {
        let out = parse(FULL_EXPORT, Some(r#"{"chatIndex":1}"#));
        assert_eq!(out.messages[1].content.as_deref(), Some("前缀 重点尾巴"));
        assert_eq!(out.messages[1].reply_to_message_id.as_deref(), Some("7"));
        assert_eq!(out.messages[0].reply_to_message_id, None);
    }

    #[test]
    fn renders_service_messages_and_drops_unparsable_timestamps() {
        let out = parse(FULL_EXPORT, Some(r#"{"chatIndex":1}"#));
        assert_eq!(out.messages[2].message_type, 80);
        assert_eq!(
            out.messages[2].content.as_deref(),
            Some("[invite_members] Bob, Carol")
        );
        // The message with a non-numeric date_unixtime is skipped, but its
        // sender was already recorded as a member (matching the TS parsers).
        assert_eq!(
            out.members
                .iter()
                .map(|member| member.platform_id.as_str())
                .collect::<Vec<_>>(),
            vec!["10001", "99", "777"]
        );
    }

    #[test]
    fn falls_back_to_the_platform_id_when_a_message_has_no_from() {
        let out = parse(FULL_EXPORT, Some(r#"{"chatIndex":1}"#));
        assert_eq!(out.messages[3].sender_platform_id, "99");
        assert_eq!(out.messages[3].sender_account_name, "99");
        let service_sender = &out.messages[2].sender_account_name;
        assert_eq!(service_sender, "Alice");
    }

    #[test]
    fn maps_media_messages_to_types_content_and_attachments() {
        let doc = r#"{
          "name": "媒体", "type": "personal_chat", "id": 5,
          "messages": [
            {"id": 1, "type": "message", "date_unixtime": "1", "from": "A", "from_id": "user1",
             "photo": "photos/photo_1.jpg", "width": 1280, "height": 960, "text": "caption 说明"},
            {"id": 2, "type": "message", "date_unixtime": "2", "from": "A", "from_id": "user1",
             "file": "voice_messages/audio_1.ogg", "media_type": "voice_message", "mime_type": "audio/ogg", "duration_seconds": 3, "text": ""},
            {"id": 3, "type": "message", "date_unixtime": "3", "from": "A", "from_id": "user1",
             "file": "stickers/s.webp", "media_type": "sticker", "sticker_emoji": "🎉", "text": ""},
            {"id": 4, "type": "message", "date_unixtime": "4", "from": "A", "from_id": "user1",
             "file": "files/doc.pdf", "file_name": "报告.pdf", "mime_type": "application/pdf", "text": ""}
          ]
        }"#;
        let out = parse(doc, Some(r#"{"single":true}"#));
        assert_eq!(meta(&out)["chatType"], "private");
        assert_eq!(meta(&out)["chatIndex"], Value::Null);

        assert_eq!(out.messages[0].message_type, 1);
        assert_eq!(
            out.messages[0].content.as_deref(),
            Some("[photo] caption 说明")
        );
        let photo = &out.messages[0].attachments.as_ref().unwrap()[0];
        assert_eq!(photo.kind, "image");
        assert_eq!(photo.path, "photos/photo_1.jpg");
        assert_eq!(photo.width, Some(1280.0));
        assert_eq!(photo.duration_ms, None);

        assert_eq!(out.messages[1].message_type, 2);
        assert_eq!(out.messages[1].content.as_deref(), Some("[voice_message]"));
        let voice = &out.messages[1].attachments.as_ref().unwrap()[0];
        assert_eq!(voice.kind, "audio");
        assert_eq!(voice.mime_type.as_deref(), Some("audio/ogg"));
        assert_eq!(voice.duration_ms, Some(3000.0));

        assert_eq!(out.messages[2].message_type, 1);
        assert_eq!(out.messages[2].content.as_deref(), Some("[sticker 🎉]"));
        assert_eq!(
            out.messages[2].attachments.as_ref().unwrap()[0].kind,
            "sticker"
        );

        assert_eq!(out.messages[3].message_type, 4);
        assert_eq!(out.messages[3].content.as_deref(), Some("[file]"));
        let file = &out.messages[3].attachments.as_ref().unwrap()[0];
        assert_eq!(file.kind, "file");
        assert_eq!(file.name.as_deref(), Some("报告.pdf"));
    }

    #[test]
    fn parses_single_chat_exports_and_names_actorless_service_messages() {
        let doc = r#"{
          "name": "", "type": "saved_messages", "id": 42,
          "messages": [
            {"id": 1, "type": "service", "date_unixtime": "10", "actor_id": "user5", "action": "", "text": "系统提示"},
            {"id": 2, "type": "message", "date_unixtime": "11", "from": "Me", "from_id": "user5", "text": "hi"}
          ]
        }"#;
        let out = parse(doc, Some(r#"{"single":true}"#));
        assert_eq!(meta(&out)["name"], "Telegram Chat 42");
        assert_eq!(meta(&out)["groupId"], Value::Null);
        assert_eq!(out.messages[0].sender_account_name, "System");
        assert_eq!(out.messages[0].content.as_deref(), Some("系统提示"));
        assert_eq!(out.members.len(), 1);
        assert_eq!(out.members[0].account_name, "System");
    }

    #[test]
    fn reports_a_missing_chat_index_instead_of_parsing_the_wrong_chat() {
        let input = KernelInput {
            primary_path: "/tmp/telegram.json".to_string(),
            options_json: Some(r#"{"chatIndex":9}"#.to_string()),
        };
        let error = parse_telegram(FULL_EXPORT.as_bytes(), &input, |_, _| {})
            .map(|_| ())
            .expect_err("an out-of-range chat index should fail");
        assert!(error.message.contains("chat index 9"));
    }

    #[test]
    fn reports_progress_by_consumed_bytes() {
        let input = KernelInput {
            primary_path: "/tmp/telegram.json".to_string(),
            options_json: Some(r#"{"chatIndex":1}"#.to_string()),
        };
        let mut samples: Vec<(u64, u64)> = Vec::new();
        parse_telegram(FULL_EXPORT.as_bytes(), &input, |bytes, messages| {
            samples.push((bytes, messages))
        })
        .expect("parse should succeed");
        assert_eq!(samples.len(), 4);
        assert!(samples[0].0 > 0 && samples[0].0 < FULL_EXPORT.len() as u64);
        assert!(samples.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert_eq!(samples.last().unwrap().1, 4);
    }
}
