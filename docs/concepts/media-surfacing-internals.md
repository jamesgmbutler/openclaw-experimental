# Media Surfacing Internals

How does a local file (image, audio, video, document) get from the gateway
filesystem to the user's messaging channel? This page traces the three
mechanisms available today, explains which ones the LLM agent can control
directly, and clarifies the relationship between structured
`details.media.mediaUrls` and the legacy `MEDIA:` text token.

---

## Extraction Priority Chain

When a tool finishes, `extractToolResultMediaArtifact()` in
`src/agents/pi-embedded-subscribe.tools.ts` runs through the following
strategies in order. **First match wins**:

1. **Structured `details.media`** — read `result.details.media.mediaUrl` and
   `result.details.media.mediaUrls`.
2. **Legacy `MEDIA:` tokens** — scan every text content block for
   `MEDIA:/path` lines using `splitMediaFromOutput()`.
3. **Legacy `details.path` fallback** — if the result contains image content
   blocks but no `MEDIA:` text and no structured media, fall back to
   `result.details.path`.

The extracted artifact is a `ToolResultMediaArtifact`:

```ts
type ToolResultMediaArtifact = {
  mediaUrls: string[];
  audioAsVoice?: boolean;
};
```

---

## Mechanism 1 — Structured `details.media` (Tool-Internal Only)

### Who produces it

Built-in tool implementations — **not** the LLM. The LLM invokes a tool; the
tool's server-side handler generates the file, saves it to disk, and returns a
result object with `details.media` already populated. The LLM never constructs
this object itself.

### Producers

| Tool | Source file | Shape |
|---|---|---|
| `image_generate` | `src/agents/tools/image-generate-tool.ts` | `media: { mediaUrls: savedImages.map(i => i.path) }` |
| `video_generate` | `src/agents/tools/video-generate-tool.ts` | `media: { mediaUrls: savedVideos.map(v => v.path) }` |
| `music_generate` | `src/agents/tools/music-generate-tool.ts` | `media: { mediaUrls: savedTracks.map(t => t.path) }` |
| `tts` | `src/agents/tools/tts-tool.ts` | `media: { mediaUrl: result.audioPath, audioAsVoice: true }` |
| `nodes` (camera / photos) | `src/agents/tools/nodes-tool-media.ts` | `media: { mediaUrls: details.filter(...).map(s => s.path) }` |
| `imageResult()` helper | `src/agents/tools/common.ts` | `media: { mediaUrl: params.path }` |

### Extraction path

```
extractToolResultMediaArtifact(result)
  → readToolResultDetailsMedia(result)       // reads result.details.media
  → collectStructuredMediaUrls(media)        // reads media.mediaUrl + media.mediaUrls
  → { mediaUrls: [...], audioAsVoice?: true }
```

### Key point

An LLM agent **cannot** directly choose to use this path. It happens
automatically when the agent calls one of the tools above. The agent's only
role is to invoke `image_generate`, `tts`, `music_generate`, etc.

---

## Mechanism 2 — Legacy `MEDIA:` Text Token

### Who produces it

Either a tool's text output (for example `exec` / bash) or the LLM's own
assistant text reply.

### Path A — `MEDIA:` in tool result text

When the agent calls `exec` and the command's stdout contains
`MEDIA:/path/to/file.pdf`, the extraction logic finds it.

**Flow** (`src/agents/pi-embedded-subscribe.tools.ts`):

```
extractToolResultMediaArtifact(result)
  → (no details.media found)
  → iterate result.content[] text blocks
  → for each text block: splitMediaFromOutput(entry.text)
  → collects MEDIA: paths from line-start tokens
  → { mediaUrls: ["/path/to/file.pdf"] }
```

Parsing lives in `splitMediaFromOutput()` (`src/media/parse.ts`). It
recognises `MEDIA:` at the start of a line (with optional leading whitespace),
strips backtick wrapping, and validates the value is a real path or URL.

**Important:** The `exec` tool result (`src/agents/bash-tools.exec-host-node.ts`)
does **not** produce `details.media`. It only sets
`details: { status, exitCode, durationMs, ... }`. So for exec results,
**only the `MEDIA:` text approach works**.

### Path B — `MEDIA:` in assistant text reply

When the LLM writes `MEDIA:/path/to/file.pdf` directly in its text reply (not
inside a tool call), the reply-directives parser picks it up:

```
parseReplyDirectives(raw)                      // src/auto-reply/reply/reply-directives.ts
  → splitMediaFromOutput(raw)
  → { text, mediaUrls: ["/path/to/file.pdf"] }
```

This sets `mediaUrls` on the `ReplyPayload`, which then flows to the channel
adapter.

### Security gate

`filterToolResultMediaUrls()` (`src/agents/pi-embedded-subscribe.tools.ts`)
enforces trust:

- If the tool is in the `TRUSTED_TOOL_RESULT_MEDIA` set (exec, read, image,
  image\_generate, etc.) or `TRUSTED_BUNDLED_PLUGIN_MEDIA_TOOLS`: local file
  paths are allowed through.
- If the tool is untrusted (MCP / external plugin tools, identified by
  `details.mcpServer` or `details.mcpTool`): **only** `https?://` URLs pass.

So for a trusted tool like `exec`:

```bash
echo "MEDIA:/workspace/report.pdf"
```

produces `/workspace/report.pdf` as a trusted local media URL.

---

## Mechanism 3 — The `message` Tool (Direct Agent Control)

The agent can call the `message` tool
(`src/agents/tools/message-tool.ts`) with explicit media parameters:

```json
{
  "tool": "message",
  "action": "send",
  "message": "Here is the report",
  "media": "/workspace/report.pdf",
  "channel": "whatsapp"
}
```

### Relevant schema fields

| Parameter | Type | Description |
|---|---|---|
| `media` | `string?` | Media URL or local path |
| `filename` | `string?` | Override filename |
| `buffer` | `string?` | Base64 payload for attachments (optionally a `data:` URL) |
| `contentType` | `string?` | MIME type |
| `path` / `filePath` | `string?` | Alias for local file path |
| `forceDocument` | `boolean?` | Send as document to avoid compression (Telegram) |
| `asDocument` | `boolean?` | Alias for `forceDocument` |
| `asVoice` | `boolean?` | Send audio as a voice message |

The `message-action-runner.ts` reads `media` from params and passes it as
`mediaUrl` to `executeSendAction()`, which routes through the channel adapter.

---

## Summary — What Should the Agent Do?

| Goal | Best method | How |
|---|---|---|
| Send a generated image / video / music | Call `image_generate` / `video_generate` / `music_generate` | Structured `details.media.mediaUrls` is set automatically by the tool |
| Send a TTS audio clip | Call `tts` | `details.media.mediaUrl` + `audioAsVoice` set automatically |
| Send an arbitrary local file explicitly | Call `message` with `media: "/path/to/file"` | Sent via message-action-runner |
| Send a file created by a bash command | Run `exec`; have the command print `MEDIA:/path/to/file` to stdout | Legacy `MEDIA:` extraction from tool text |
| Send a file in the assistant reply | Write `MEDIA:/path/to/file` in the reply text | Parsed by `splitMediaFromOutput` in reply-directives |

### Can the agent use `details.media.mediaUrls` directly?

**No.** The LLM agent cannot construct the `details.media` object itself. That
structure is an internal tool-result contract between server-side tool handlers
and the media extraction layer. The agent's available approaches for surfacing
a local file are:

1. **`message` tool** (preferred for explicit sends) — call with
   `action: "send"` and `media: "/workspace/report.pdf"`.
2. **`MEDIA:` in exec output** — have a bash / exec command print
   `MEDIA:/workspace/report.pdf` to stdout.
3. **`MEDIA:` in assistant text** — write `MEDIA:/workspace/report.pdf` in the
   reply text (parsed by reply-directives).
4. **Indirectly via generation tools** — call `image_generate`, `tts`, etc.
   The structured media path is handled transparently by the tool.
