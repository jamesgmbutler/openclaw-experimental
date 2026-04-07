import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import { createChannelOutboundRuntimeSend } from "./channel-outbound-send.js";

const mockOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  sendText: vi.fn(async () => ({ channel: "whatsapp", messageId: "text-m1" })),
  sendMedia: vi.fn(async () => ({ channel: "whatsapp", messageId: "media-m1" })),
};

vi.mock("../../channels/plugins/outbound/load.js", () => ({
  loadChannelOutboundAdapter: vi.fn(async () => mockOutbound),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
}));

describe("createChannelOutboundRuntimeSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes through sendText when no mediaUrl is provided", async () => {
    const runtime = createChannelOutboundRuntimeSend({
      channelId: "whatsapp",
      unavailableMessage: "unavailable",
    });

    await runtime.sendMessage("to-id", "hello");

    expect(mockOutbound.sendText).toHaveBeenCalledTimes(1);
    expect(mockOutbound.sendMedia).not.toHaveBeenCalled();
  });

  it("routes through sendMedia when mediaUrl is provided and adapter supports it", async () => {
    const runtime = createChannelOutboundRuntimeSend({
      channelId: "whatsapp",
      unavailableMessage: "unavailable",
    });

    await runtime.sendMessage("to-id", "caption", { mediaUrl: "https://example.com/image.png" });

    expect(mockOutbound.sendMedia).toHaveBeenCalledTimes(1);
    expect(mockOutbound.sendText).not.toHaveBeenCalled();
    const ctx = vi.mocked(mockOutbound.sendMedia!).mock.calls[0][0];
    expect(ctx.mediaUrl).toBe("https://example.com/image.png");
    expect(ctx.text).toBe("caption");
    expect(ctx.to).toBe("to-id");
  });

  it("falls back to sendText when mediaUrl is provided but adapter lacks sendMedia", async () => {
    const outboundNoMedia: ChannelOutboundAdapter = {
      deliveryMode: "gateway",
      sendText: vi.fn(async () => ({ channel: "whatsapp", messageId: "text-m2" })),
    };
    vi.mocked(loadChannelOutboundAdapter).mockResolvedValueOnce(outboundNoMedia);

    const runtime = createChannelOutboundRuntimeSend({
      channelId: "whatsapp",
      unavailableMessage: "unavailable",
    });

    await runtime.sendMessage("to-id", "text", { mediaUrl: "https://example.com/image.png" });

    expect(outboundNoMedia.sendText).toHaveBeenCalledTimes(1);
  });

  it("passes mediaLocalRoots and other opts through to sendMedia context", async () => {
    const runtime = createChannelOutboundRuntimeSend({
      channelId: "whatsapp",
      unavailableMessage: "unavailable",
    });
    const localRoots = ["/tmp/media"];

    await runtime.sendMessage("to-id", "caption", {
      mediaUrl: "file:///tmp/media/photo.jpg",
      mediaLocalRoots: localRoots,
      accountId: "acc1",
      gifPlayback: true,
    });

    expect(mockOutbound.sendMedia).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(mockOutbound.sendMedia!).mock.calls[0][0];
    expect(ctx.mediaUrl).toBe("file:///tmp/media/photo.jpg");
    expect(ctx.mediaLocalRoots).toBe(localRoots);
    expect(ctx.accountId).toBe("acc1");
    expect(ctx.gifPlayback).toBe(true);
  });
});
