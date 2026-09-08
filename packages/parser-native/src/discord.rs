//! Tyrrrz/DiscordChatExporter JSON export kernel.
//!
//! Replicates `packages/parser/src/formats/tyrrrz-discord-exporter.ts`, which
//! is the reference implementation: any semantic difference is a bug (covered
//! by the TS-side parity tests).
//!
//! One deliberate difference: the TS parser pulls `guild` and `channel` out of
//! the first 10 KB with a `\{[^}]+\}` regex, so it silently loses them when
//! either object is nested or holds a `}` inside a string. The kernel reads
//! them from the real JSON instead.
//!
//! Fields whose TS path would leave the string branch (a numeric `author.id`,
//! a missing `timestamp`, a non-array `author.roles`, …) make the kernel bail
//! out with an error, which the caller turns into a TS re-parse.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::input::KernelInput;
use crate::jsutil::truthy_str;
use crate::protocol::{
    KernelOutput, NativeAttachment, NativeMember, NativeMemberRole, NativeMessage,
};
use crate::scanner::{for_each_array_element, scan_error, walk_top_level, ScanResult};

/// `chatName` fallback when neither guild nor channel carries a usable name.
const UNKNOWN_CHANNEL: &str = "未知频道";

/// Shape of `metaJson()` for the discord kernel (consumed by the TS adapter).
/// `null` stands for the TS parser's `undefined` (`channel?.id`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscordMeta {
    name: String,
    group_id: Option<String>,
    group_avatar: Option<String>,
}

// ==================== MessageType mapping ====================

const TYPE_TEXT: u32 = 0;
const TYPE_IMAGE: u32 = 1;
const TYPE_VOICE: u32 = 2;
const TYPE_VIDEO: u32 = 3;
const TYPE_FILE: u32 = 4;
const TYPE_EMOJI: u32 = 5;
const TYPE_LINK: u32 = 7;
const TYPE_CALL: u32 = 23;
const TYPE_REPLY: u32 = 25;
const TYPE_SYSTEM: u32 = 80;
const TYPE_OTHER: u32 = 99;

/// `mapDiscordMessageType`: the exact same case list, in the same order.
fn map_discord_message_type(kind: &str) -> u32 {
    match kind {
        "Default" | "ThreadStarterMessage" => TYPE_TEXT,
        "Reply" => TYPE_REPLY,
        "Call" => TYPE_CALL,
        "RecipientAdd"
        | "RecipientRemove"
        | "ChannelNameChange"
        | "ChannelIconChange"
        | "ChannelPinnedMessage"
        | "UserJoin"
        | "GuildBoost"
        | "GuildBoostTier1"
        | "GuildBoostTier2"
        | "GuildBoostTier3"
        | "ChannelFollowAdd"
        | "ThreadCreated"
        | "ChatInputCommand"
        | "ContextMenuCommand"
        | "AutoModerationAction"
        | "StageStart"
        | "StageEnd"
        | "StageSpeaker"
        | "StageTopic"
        | "GuildDiscoveryDisqualified"
        | "GuildDiscoveryRequalified"
        | "GuildDiscoveryGracePeriodInitialWarning"
        | "GuildDiscoveryGracePeriodFinalWarning"
        | "GuildInviteReminder"
        | "RoleSubscriptionPurchase"
        | "InteractionPremiumUpsell"
        | "GuildApplicationPremiumSubscription" => TYPE_SYSTEM,
        _ => TYPE_OTHER,
    }
}

// ==================== Attachment classification ====================

const IMAGE_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const VIDEO_EXTENSIONS: [&str; 5] = ["mp4", "webm", "mov", "avi", "mkv"];
const AUDIO_EXTENSIONS: [&str; 5] = ["mp3", "wav", "ogg", "flac", "m4a"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum AttachmentClass {
    Image,
    Video,
    Audio,
    File,
}

/// `/\.(ext|…)$/i` on an ASCII extension list.
fn has_extension(lowercased: &str, extensions: &[&str]) -> bool {
    extensions.iter().any(|extension| {
        lowercased.len() > extension.len()
            && lowercased.ends_with(extension)
            && lowercased.as_bytes()[lowercased.len() - extension.len() - 1] == b'.'
    })
}

fn classify_attachment(file_name: &str) -> AttachmentClass {
    let lowercased = file_name.to_ascii_lowercase();
    if has_extension(&lowercased, &IMAGE_EXTENSIONS) {
        AttachmentClass::Image
    } else if has_extension(&lowercased, &VIDEO_EXTENSIONS) {
        AttachmentClass::Video
    } else if has_extension(&lowercased, &AUDIO_EXTENSIONS) {
        AttachmentClass::Audio
    } else {
        AttachmentClass::File
    }
}

impl AttachmentClass {
    /// `getAttachmentKind`
    fn kind(self) -> &'static str {
        match self {
            AttachmentClass::Image => "image",
            AttachmentClass::Video => "video",
            AttachmentClass::Audio => "audio",
            AttachmentClass::File => "file",
        }
    }

    /// `getMessageTypeFromAttachment`
    fn message_type(self) -> u32 {
        match self {
            AttachmentClass::Image => TYPE_IMAGE,
            AttachmentClass::Video => TYPE_VIDEO,
            AttachmentClass::Audio => TYPE_VOICE,
            AttachmentClass::File => TYPE_FILE,
        }
    }

    /// `AttachmentMarkers.<kind>`
    fn marker(self, file_name: &str) -> String {
        match self {
            AttachmentClass::Image => format!("[Image: {file_name}]"),
            AttachmentClass::Video => format!("[Video: {file_name}]"),
            AttachmentClass::Audio => format!("[Audio: {file_name}]"),
            AttachmentClass::File => format!("[File: {file_name}]"),
        }
    }
}

// ==================== Field readers ====================

fn require_str<'a>(obj: &'a Map<String, Value>, key: &str, owner: &str) -> ScanResult<&'a str> {
    match obj.get(key) {
        Some(Value::String(text)) => Ok(text.as_str()),
        _ => Err(scan_error(format!("{owner}.{key} must be a string"), 0)),
    }
}

/// A field the TS parser copies through verbatim: absent is fine, any present
/// non-string value would end up in the output as-is.
fn optional_str<'a>(
    obj: &'a Map<String, Value>,
    key: &str,
    owner: &str,
) -> ScanResult<Option<&'a str>> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.as_str())),
        Some(_) => Err(scan_error(format!("unsupported {owner}.{key} value"), 0)),
    }
}

/// `msg.attachments` / `msg.embeds` / `msg.stickers`: JS-falsy stands for an
/// empty list, anything but an array leaves the TS parser's array path.
fn optional_array<'a>(
    obj: &'a Map<String, Value>,
    key: &str,
) -> ScanResult<Option<&'a Vec<Value>>> {
    match obj.get(key) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(None),
        Some(Value::Array(items)) => Ok(Some(items)),
        Some(_) => Err(scan_error(format!("unsupported {key} value"), 0)),
    }
}

fn require_object<'a>(value: &'a Value, owner: &str) -> ScanResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| scan_error(format!("{owner} must be an object"), 0))
}

// ==================== Timestamps ====================

/// JS `Math.floor(new Date(isoString).getTime() / 1000)` for the ISO 8601
/// date-time form DiscordChatExporter writes. Forms the ECMAScript grammar
/// leaves implementation-defined (no offset, a space separator, `+HHMM`) are
/// rejected so the TS parser decides instead.
fn parse_timestamp(text: &str) -> ScanResult<f64> {
    let bytes = text.as_bytes();
    let invalid = || scan_error(format!("unsupported timestamp: {text}"), 0);
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return Err(invalid());
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return Err(invalid());
    }

    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let slice = text.get(range)?;
        if !slice.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        slice.parse::<i64>().ok()
    };
    let year = number(0..4).ok_or_else(invalid)?;
    let month = number(5..7).ok_or_else(invalid)?;
    let day = number(8..10).ok_or_else(invalid)?;
    let hour = number(11..13).ok_or_else(invalid)?;
    let minute = number(14..16).ok_or_else(invalid)?;
    let second = number(17..19).ok_or_else(invalid)?;

    let mut rest = &text[19..];
    let mut millisecond = 0i64;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return Err(invalid());
        }
        // V8 keeps the first three fraction digits and drops the rest.
        for (index, byte) in fraction.as_bytes()[..digits.min(3)].iter().enumerate() {
            millisecond += i64::from(byte - b'0') * 10i64.pow(2 - index as u32);
        }
        rest = &fraction[digits..];
    }

    let offset_minutes = match rest.as_bytes() {
        b"Z" => 0,
        [sign @ (b'+' | b'-'), ..] if rest.len() == 6 && rest.as_bytes()[3] == b':' => {
            let hours = rest[1..3]
                .parse::<i64>()
                .ok()
                .filter(|_| rest[1..3].bytes().all(|byte| byte.is_ascii_digit()))
                .ok_or_else(invalid)?;
            let minutes = rest[4..6]
                .parse::<i64>()
                .ok()
                .filter(|_| rest[4..6].bytes().all(|byte| byte.is_ascii_digit()))
                .ok_or_else(invalid)?;
            if hours > 23 || minutes > 59 {
                return Err(invalid());
            }
            let total = hours * 60 + minutes;
            if *sign == b'-' {
                -total
            } else {
                total
            }
        }
        _ => return Err(invalid()),
    };

    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return Err(invalid());
    }
    if hour > 23 || minute > 59 || second > 59 {
        return Err(invalid());
    }

    let epoch_ms =
        (days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000
            + millisecond
            - offset_minutes * 60_000;
    // Outside the JS time-value range `new Date(...)` yields NaN.
    if epoch_ms.abs() > 8_640_000_000_000_000 {
        return Err(invalid());
    }
    Ok(epoch_ms.div_euclid(1_000) as f64)
}

fn is_leap_year(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days between 1970-01-01 and the given proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

// ==================== Message content ====================

/// `formatEmbed`: title, else url, else the first 30 UTF-16 units of the
/// description, else the literal "link".
fn format_embed(value: &Value) -> ScanResult<String> {
    let embed = require_object(value, "embed")?;
    let title = match truthy_str(embed.get("title"))? {
        Some(title) => title.to_string(),
        None => match truthy_str(embed.get("url"))? {
            Some(url) => url.to_string(),
            None => match embed.get("description") {
                None | Some(Value::Null) => "link".to_string(),
                Some(Value::String(description)) => {
                    let sliced = js_slice(description, 30)?;
                    if sliced.is_empty() {
                        "link".to_string()
                    } else {
                        sliced
                    }
                }
                Some(_) => return Err(scan_error("unsupported embed.description value", 0)),
            },
        },
    };
    Ok(format!("[Link: {title}]"))
}

/// `String.prototype.slice(0, limit)` counted in UTF-16 code units. A cut that
/// would split a surrogate pair leaves a lone surrogate in JS, so the kernel
/// hands those strings back to the TS parser instead.
fn js_slice(text: &str, limit: usize) -> ScanResult<String> {
    let mut units = 0usize;
    for (byte_index, character) in text.char_indices() {
        if units == limit {
            return Ok(text[..byte_index].to_string());
        }
        let next = units + character.len_utf16();
        if next > limit {
            return Err(scan_error(
                "embed description slice splits a surrogate pair",
                0,
            ));
        }
        units = next;
    }
    Ok(text.to_string())
}

/// `formatSticker`
fn format_sticker(value: &Value) -> ScanResult<String> {
    let sticker = require_object(value, "sticker")?;
    Ok(format!(
        "[Sticker: {}]",
        require_str(sticker, "name", "sticker")?
    ))
}

// ==================== Members ====================

/// Members keyed by `author.id` in first-seen order; a later message whose
/// author carries more roles replaces just the roles (as the TS parser does).
struct MemberTracker {
    order: Vec<NativeMember>,
    index: HashMap<String, usize>,
}

impl MemberTracker {
    fn new() -> Self {
        MemberTracker {
            order: Vec::new(),
            index: HashMap::new(),
        }
    }

    fn observe(
        &mut self,
        id: &str,
        name: &str,
        nickname: Option<&str>,
        avatar: Option<&str>,
        roles: Vec<NativeMemberRole>,
    ) {
        match self.index.get(id) {
            None => {
                self.index.insert(id.to_string(), self.order.len());
                self.order.push(NativeMember {
                    platform_id: id.to_string(),
                    account_name: name.to_string(),
                    group_nickname: nickname.map(str::to_string),
                    aliases: None,
                    avatar: avatar.map(str::to_string),
                    roles: Some(roles),
                });
            }
            Some(&position) => {
                let existing = &mut self.order[position];
                let existing_len = existing.roles.as_ref().map_or(0, Vec::len);
                if roles.len() > existing_len {
                    existing.roles = Some(roles);
                }
            }
        }
    }
}

fn convert_roles(author: &Map<String, Value>) -> ScanResult<Vec<NativeMemberRole>> {
    let Some(Value::Array(items)) = author.get("roles") else {
        return Err(scan_error("author.roles must be an array", 0));
    };
    items
        .iter()
        .map(|item| {
            let role = require_object(item, "author role")?;
            Ok(NativeMemberRole {
                id: require_str(role, "id", "author role")?.to_string(),
                name: optional_str(role, "name", "author role")?.map(str::to_string),
            })
        })
        .collect()
}

// ==================== Kernel ====================

fn parse_message(value: &Value, members: &mut MemberTracker) -> ScanResult<NativeMessage> {
    let message = require_object(value, "message")?;
    let author = require_object(
        message
            .get("author")
            .ok_or_else(|| scan_error("message.author is required", 0))?,
        "message.author",
    )?;

    let author_id = require_str(author, "id", "author")?;
    let author_name = require_str(author, "name", "author")?;
    let nickname = truthy_str(author.get("nickname"))?;
    let avatar = optional_str(author, "avatarUrl", "author")?;
    members.observe(
        author_id,
        author_name,
        nickname,
        avatar,
        convert_roles(author)?,
    );

    let mut message_type = map_discord_message_type(require_str(message, "type", "message")?);
    let raw_content = truthy_str(message.get("content"))?;
    let mut content = raw_content.unwrap_or("").to_string();

    let attachments = optional_array(message, "attachments")?.filter(|items| !items.is_empty());
    let mut native_attachments: Option<Vec<NativeAttachment>> = None;
    if let Some(items) = attachments {
        let mut parsed = Vec::with_capacity(items.len());
        let mut markers = Vec::with_capacity(items.len());
        for item in items {
            let attachment = require_object(item, "attachment")?;
            let file_name = require_str(attachment, "fileName", "attachment")?;
            let class = classify_attachment(file_name);
            markers.push(class.marker(file_name));
            parsed.push(NativeAttachment {
                kind: class.kind().to_string(),
                path: require_str(attachment, "url", "attachment")?.to_string(),
                name: Some(file_name.to_string()),
                mime_type: None,
                size: match attachment.get("fileSizeBytes") {
                    None => None,
                    Some(Value::Number(number)) => number.as_f64(),
                    Some(_) => {
                        return Err(scan_error("unsupported attachment.fileSizeBytes value", 0))
                    }
                },
                duration_ms: None,
                width: None,
                height: None,
            });
        }
        if content.is_empty() && items.len() == 1 {
            message_type = classify_attachment(require_str(
                require_object(&items[0], "attachment")?,
                "fileName",
                "attachment",
            )?)
            .message_type();
        }
        content = join_content(content, markers);
        native_attachments = Some(parsed);
    }

    let embeds = optional_array(message, "embeds")?.filter(|items| !items.is_empty());
    if let Some(items) = embeds {
        let markers = items.iter().map(format_embed).collect::<ScanResult<_>>()?;
        content = join_content(content, markers);
        if raw_content.is_none() && native_attachments.is_none() {
            message_type = TYPE_LINK;
        }
    }

    let stickers = optional_array(message, "stickers")?.filter(|items| !items.is_empty());
    if let Some(items) = stickers {
        let markers = items
            .iter()
            .map(format_sticker)
            .collect::<ScanResult<_>>()?;
        content = join_content(content, markers);
        if raw_content.is_none() && native_attachments.is_none() && embeds.is_none() {
            message_type = TYPE_EMOJI;
        }
    }

    let reply_to = match message.get("reference") {
        None | Some(Value::Null) => None,
        Some(reference) => {
            truthy_str(require_object(reference, "message.reference")?.get("messageId"))?
        }
    };

    Ok(NativeMessage {
        platform_message_id: optional_str(message, "id", "message")?.map(str::to_string),
        sender_platform_id: author_id.to_string(),
        sender_account_name: author_name.to_string(),
        sender_group_nickname: nickname.map(str::to_string),
        timestamp: Some(parse_timestamp(require_str(
            message,
            "timestamp",
            "message",
        )?)?),
        message_type,
        content: (!content.is_empty()).then_some(content),
        reply_to_message_id: reply_to.map(str::to_string),
        attachments: native_attachments,
    })
}

/// `content ? `${content}\n${parts.join('\n')}` : parts.join('\n')`
fn join_content(content: String, parts: Vec<String>) -> String {
    let joined = parts.join("\n");
    if content.is_empty() {
        joined
    } else {
        format!("{content}\n{joined}")
    }
}

pub fn parse_discord(
    buf: &[u8],
    _input: &KernelInput,
    mut on_progress: impl FnMut(u64, u64),
) -> ScanResult<KernelOutput> {
    let mut guild_raw: Option<&[u8]> = None;
    let mut channel_raw: Option<&[u8]> = None;
    let mut messages_raw: Option<&[u8]> = None;
    walk_top_level(buf, |key, raw| {
        match key {
            b"guild" => guild_raw = Some(raw),
            b"channel" => channel_raw = Some(raw),
            b"messages" => messages_raw = Some(raw),
            _ => {}
        }
        Ok(())
    })?;

    let header = |raw: Option<&[u8]>, owner: &str| -> ScanResult<Option<Map<String, Value>>> {
        let Some(raw) = raw else { return Ok(None) };
        let value: Value = serde_json::from_slice(raw)
            .map_err(|error| scan_error(format!("invalid {owner}: {error}"), 0))?;
        Ok(Some(require_object(&value, owner)?.clone()))
    };
    let guild = header(guild_raw, "guild")?;
    let channel = header(channel_raw, "channel")?;

    // `guild && channel ? `${guild.name} - ${channel.name}` : channel?.name || '未知频道'`
    let name = match (&guild, &channel) {
        (Some(guild), Some(channel)) => format!(
            "{} - {}",
            require_str(guild, "name", "guild")?,
            require_str(channel, "name", "channel")?
        ),
        (_, Some(channel)) => truthy_str(channel.get("name"))?
            .unwrap_or(UNKNOWN_CHANNEL)
            .to_string(),
        (_, None) => UNKNOWN_CHANNEL.to_string(),
    };
    let meta_json = serde_json::to_string(&DiscordMeta {
        name,
        group_id: channel
            .as_ref()
            .map(|channel| require_str(channel, "id", "channel").map(str::to_string))
            .transpose()?,
        group_avatar: guild
            .as_ref()
            .map(|guild| optional_str(guild, "iconUrl", "guild"))
            .transpose()?
            .flatten()
            .map(str::to_string),
    })
    .map_err(|error| scan_error(format!("meta serialization failed: {error}"), 0))?;

    let mut members = MemberTracker::new();
    let mut messages: Vec<NativeMessage> = Vec::new();
    if let Some(raw) = messages_raw {
        let base_offset = raw.as_ptr() as usize - buf.as_ptr() as usize;
        for_each_array_element(raw, base_offset, |element, end_offset| {
            let element_offset = end_offset.saturating_sub(element.len());
            let value: Value = serde_json::from_slice(element)
                .map_err(|error| scan_error(format!("invalid message: {error}"), element_offset))?;
            messages.push(
                parse_message(&value, &mut members)
                    .map_err(|error| scan_error(error.message, element_offset))?,
            );
            on_progress(end_offset as u64, messages.len() as u64);
            Ok(())
        })?;
    }

    Ok(KernelOutput {
        meta_json,
        members: members.order,
        messages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(doc: &str) -> KernelOutput {
        let input = KernelInput {
            primary_path: "/tmp/discord.json".to_string(),
            options_json: None,
        };
        parse_discord(doc.as_bytes(), &input, |_, _| {}).expect("parse should succeed")
    }

    fn meta(out: &KernelOutput) -> Value {
        serde_json::from_str(&out.meta_json).expect("meta_json should be valid JSON")
    }

    fn author(id: &str, roles: &str) -> String {
        format!(
            r#""author": {{"id": "{id}", "name": "用户{id}", "discriminator": "0000",
             "nickname": "昵称{id}", "isBot": false, "roles": {roles},
             "avatarUrl": "https://cdn/{id}.png"}}"#
        )
    }

    const GUILD_AND_CHANNEL: &str = r#""guild": {"id": "g1", "name": "公会 Guild", "iconUrl": "https://cdn/icon.png"},
      "channel": {"id": "c1", "type": "GuildTextChat", "name": "general", "topic": "话题"},"#;

    #[test]
    fn maps_default_reply_and_system_types() {
        let doc = format!(
            r#"{{
              {GUILD_AND_CHANNEL}
              "messages": [
                {{"id": "m1", "type": "Default", "timestamp": "2024-01-02T03:04:05.000+00:00",
                  "content": "hello discord", {}, "attachments": [], "embeds": [], "stickers": []}},
                {{"id": "m2", "type": "Reply", "timestamp": "2024-01-02T03:05:05.123+00:00",
                  "content": "回复", {}, "attachments": [], "embeds": [], "stickers": [],
                  "reference": {{"messageId": "m1", "channelId": "c1", "guildId": null}}}},
                {{"id": "m3", "type": "ChannelPinnedMessage", "timestamp": "2024-01-02T03:06:05.000+02:00",
                  "content": "", {}, "attachments": [], "embeds": [], "stickers": []}},
                {{"id": "m4", "type": "SomethingNew", "timestamp": "2024-01-02T03:07:05.000+00:00",
                  "content": "unknown", {}, "attachments": [], "embeds": [], "stickers": []}}
              ]
            }}"#,
            author("a1", "[]"),
            author("a1", "[]"),
            author("a1", "[]"),
            author("a1", "[]")
        );
        let out = parse(&doc);

        assert_eq!(meta(&out)["name"], "公会 Guild - general");
        assert_eq!(meta(&out)["groupId"], "c1");
        assert_eq!(meta(&out)["groupAvatar"], "https://cdn/icon.png");

        assert_eq!(out.messages[0].message_type, TYPE_TEXT);
        assert_eq!(out.messages[0].platform_message_id.as_deref(), Some("m1"));
        assert_eq!(out.messages[0].timestamp, Some(1704164645.0));
        assert_eq!(out.messages[0].reply_to_message_id, None);

        assert_eq!(out.messages[1].message_type, TYPE_REPLY);
        assert_eq!(out.messages[1].reply_to_message_id.as_deref(), Some("m1"));
        // .123 is dropped by the floor to whole seconds, +02:00 shifts back.
        assert_eq!(out.messages[2].timestamp, Some(1704164765.0 - 7200.0));
        assert_eq!(out.messages[2].message_type, TYPE_SYSTEM);
        assert_eq!(out.messages[2].content, None);
        assert_eq!(out.messages[3].message_type, TYPE_OTHER);

        assert_eq!(out.members.len(), 1);
        assert_eq!(out.members[0].platform_id, "a1");
        assert_eq!(out.members[0].group_nickname.as_deref(), Some("昵称a1"));
        assert_eq!(out.members[0].avatar.as_deref(), Some("https://cdn/a1.png"));
        assert!(out.members[0].roles.as_ref().unwrap().is_empty());
    }

    #[test]
    fn rewrites_the_type_of_a_content_less_single_attachment_message() {
        let cases = [
            ("photo.PNG", TYPE_IMAGE, "image", "[Image: photo.PNG]"),
            ("clip.mp4", TYPE_VIDEO, "video", "[Video: clip.mp4]"),
            ("voice.ogg", TYPE_VOICE, "audio", "[Audio: voice.ogg]"),
            ("报告.pdf", TYPE_FILE, "file", "[File: 报告.pdf]"),
            ("nodot", TYPE_FILE, "file", "[File: nodot]"),
        ];
        for (file_name, expected_type, expected_kind, expected_marker) in cases {
            let doc = format!(
                r#"{{
                  {GUILD_AND_CHANNEL}
                  "messages": [
                    {{"id": "m1", "type": "Default", "timestamp": "2024-01-02T03:04:05.000+00:00",
                      "content": "", {},
                      "attachments": [{{"id": "at1", "url": "files/{file_name}", "fileName": "{file_name}", "fileSizeBytes": 4096}}],
                      "embeds": [], "stickers": []}}
                  ]
                }}"#,
                author("a1", "[]")
            );
            let out = parse(&doc);
            assert_eq!(out.messages[0].message_type, expected_type, "{file_name}");
            assert_eq!(out.messages[0].content.as_deref(), Some(expected_marker));
            let attachment = &out.messages[0].attachments.as_ref().unwrap()[0];
            assert_eq!(attachment.kind, expected_kind, "{file_name}");
            assert_eq!(attachment.path, format!("files/{file_name}"));
            assert_eq!(attachment.name.as_deref(), Some(file_name));
            assert_eq!(attachment.size, Some(4096.0));
        }
    }

    #[test]
    fn appends_attachment_embed_and_sticker_markers_in_ts_order() {
        let doc = format!(
            r#"{{
              {GUILD_AND_CHANNEL}
              "messages": [
                {{"id": "m1", "type": "Default", "timestamp": "2024-01-02T03:04:05.000+00:00",
                  "content": "看这些", {},
                  "attachments": [
                    {{"id": "at1", "url": "files/a.png", "fileName": "a.png", "fileSizeBytes": 1}},
                    {{"id": "at2", "url": "files/b.zip", "fileName": "b.zip"}}
                  ],
                  "embeds": [{{"title": "标题", "url": "https://example.com"}}],
                  "stickers": [{{"id": "s1", "name": "贴纸", "format": "PNG"}}]}},
                {{"id": "m2", "type": "Default", "timestamp": "2024-01-02T03:05:05.000+00:00",
                  "content": "", {},
                  "attachments": [],
                  "embeds": [{{"url": "https://only-url"}}, {{"description": "0123456789012345678901234567890123"}}, {{}}],
                  "stickers": []}},
                {{"id": "m3", "type": "Default", "timestamp": "2024-01-02T03:06:05.000+00:00",
                  "content": "", {},
                  "attachments": [], "embeds": [],
                  "stickers": [{{"id": "s2", "name": "只有贴纸", "format": "PNG"}}]}}
              ]
            }}"#,
            author("a1", "[]"),
            author("a1", "[]"),
            author("a1", "[]")
        );
        let out = parse(&doc);

        assert_eq!(
            out.messages[0].content.as_deref(),
            Some("看这些\n[Image: a.png]\n[File: b.zip]\n[Link: 标题]\n[Sticker: 贴纸]")
        );
        // Content present, so neither the embed nor the sticker rewrites the type.
        assert_eq!(out.messages[0].message_type, TYPE_TEXT);
        assert_eq!(out.messages[0].attachments.as_ref().unwrap()[1].size, None);

        assert_eq!(out.messages[1].message_type, TYPE_LINK);
        assert_eq!(
            out.messages[1].content.as_deref(),
            Some("[Link: https://only-url]\n[Link: 012345678901234567890123456789]\n[Link: link]")
        );

        assert_eq!(out.messages[2].message_type, TYPE_EMOJI);
        assert_eq!(
            out.messages[2].content.as_deref(),
            Some("[Sticker: 只有贴纸]")
        );
        assert!(out.messages[2].attachments.is_none());
    }

    #[test]
    fn keeps_the_longest_role_list_seen_for_a_member() {
        let doc = format!(
            r#"{{
              {GUILD_AND_CHANNEL}
              "messages": [
                {{"id": "m1", "type": "Default", "timestamp": "2024-01-02T03:04:05.000+00:00",
                  "content": "one", {}, "attachments": [], "embeds": [], "stickers": []}},
                {{"id": "m2", "type": "Default", "timestamp": "2024-01-02T03:05:05.000+00:00",
                  "content": "two", {}, "attachments": [], "embeds": [], "stickers": []}},
                {{"id": "m3", "type": "Default", "timestamp": "2024-01-02T03:06:05.000+00:00",
                  "content": "three", {}, "attachments": [], "embeds": [], "stickers": []}}
              ]
            }}"#,
            author("a1", r#"[{"id": "r1", "name": "成员"}]"#),
            author("a1", r#"[{"id": "r1", "name": "成员"}, {"id": "r2"}]"#),
            author("a1", r#"[{"id": "r9", "name": "只有一个"}]"#)
        );
        let out = parse(&doc);

        assert_eq!(out.members.len(), 1);
        let roles = out.members[0].roles.as_ref().unwrap();
        assert_eq!(roles.len(), 2);
        assert_eq!(roles[0].id, "r1");
        assert_eq!(roles[0].name.as_deref(), Some("成员"));
        assert_eq!(roles[1].id, "r2");
        assert_eq!(roles[1].name, None);
    }

    #[test]
    fn treats_a_missing_content_key_as_an_empty_string() {
        let doc = format!(
            r#"{{
              {GUILD_AND_CHANNEL}
              "messages": [
                {{"id": "m1", "type": "Default", "timestamp": "2024-01-02T03:04:05.000+00:00",
                  {}, "attachments": [], "embeds": [], "stickers": []}}
              ]
            }}"#,
            author("a1", "[]")
        );
        let out = parse(&doc);
        assert_eq!(out.messages[0].content, None);
        assert_eq!(out.messages[0].message_type, TYPE_TEXT);
    }

    #[test]
    fn names_the_chat_from_the_channel_alone_when_the_guild_is_missing() {
        let doc = r#"{
          "channel": {"id": "c1", "type": "DirectTextChat", "name": "direct"},
          "messages": []
        }"#;
        let out = parse(doc);
        assert_eq!(meta(&out)["name"], "direct");
        assert_eq!(meta(&out)["groupId"], "c1");
        assert_eq!(meta(&out)["groupAvatar"], Value::Null);

        let nameless =
            r#"{"channel": {"id": "c1", "type": "DirectTextChat", "name": ""}, "messages": []}"#;
        assert_eq!(meta(&parse(nameless))["name"], "未知频道");
    }

    #[test]
    fn refuses_values_the_ts_parser_would_stringify_or_throw_on() {
        let cases: [(&str, &str); 4] = [
            (
                "numeric author id",
                r#""author": {"id": 1, "name": "A", "roles": []}"#,
            ),
            ("missing roles", r#""author": {"id": "a1", "name": "A"}"#),
            (
                "numeric nickname",
                r#""author": {"id": "a1", "name": "A", "nickname": 5, "roles": []}"#,
            ),
            (
                "null avatarUrl",
                r#""author": {"id": "a1", "name": "A", "avatarUrl": null, "roles": []}"#,
            ),
        ];
        for (label, author_json) in cases {
            let doc = format!(
                r#"{{{GUILD_AND_CHANNEL}
                  "messages": [{{"id": "m1", "type": "Default",
                    "timestamp": "2024-01-02T03:04:05.000+00:00", "content": "x", {author_json},
                    "attachments": [], "embeds": [], "stickers": []}}]}}"#
            );
            let input = KernelInput {
                primary_path: "/tmp/discord.json".to_string(),
                options_json: None,
            };
            assert!(
                parse_discord(doc.as_bytes(), &input, |_, _| {}).is_err(),
                "{label} should be handed back to the TS parser"
            );
        }
    }

    #[test]
    fn parses_the_iso_timestamp_forms_javascript_agrees_on() {
        assert_eq!(
            parse_timestamp("2024-01-02T03:04:05.000+00:00").unwrap(),
            1704164645.0
        );
        assert_eq!(
            parse_timestamp("2024-01-02T03:04:05Z").unwrap(),
            1704164645.0
        );
        // DiscordChatExporter writes up to seven fraction digits; V8 keeps three.
        assert_eq!(
            parse_timestamp("2024-01-02T03:04:05.7891234+00:00").unwrap(),
            1704164645.0
        );
        assert_eq!(
            parse_timestamp("2021-05-01T12:34:56.789+02:00").unwrap(),
            1619865296.0
        );
        // Pre-epoch sub-second times floor towards -inf, as Math.floor does.
        assert_eq!(parse_timestamp("1969-12-31T23:59:59.500Z").unwrap(), -1.0);
        for invalid in [
            "2021-05-01T12:34:56",      // no offset: local time, host dependent
            "2021-05-01 12:34:56Z",     // space separator
            "2021-05-01T12:34:56+0200", // offset without a colon
            "2021-02-30T12:34:56Z",     // not a real date
            "2021-13-01T12:34:56Z",
            "garbage",
        ] {
            assert!(parse_timestamp(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn reports_progress_by_consumed_bytes() {
        let doc = format!(
            r#"{{
              {GUILD_AND_CHANNEL}
              "messages": [
                {{"id": "m1", "type": "Default", "timestamp": "2024-01-02T03:04:05.000+00:00",
                  "content": "one", {}, "attachments": [], "embeds": [], "stickers": []}},
                {{"id": "m2", "type": "Default", "timestamp": "2024-01-02T03:05:05.000+00:00",
                  "content": "two", {}, "attachments": [], "embeds": [], "stickers": []}}
              ]
            }}"#,
            author("a1", "[]"),
            author("a2", "[]")
        );
        let input = KernelInput {
            primary_path: "/tmp/discord.json".to_string(),
            options_json: None,
        };
        let mut samples: Vec<(u64, u64)> = Vec::new();
        parse_discord(doc.as_bytes(), &input, |bytes, count| {
            samples.push((bytes, count))
        })
        .expect("parse should succeed");
        assert_eq!(samples.len(), 2);
        assert!(samples[0].0 > 0 && samples[0].0 < doc.len() as u64);
        assert!(samples[0].0 < samples[1].0);
        assert_eq!(samples[1].1, 2);
    }
}
