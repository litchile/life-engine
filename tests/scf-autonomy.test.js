import { describe, expect, it } from "vitest";
import {
  dailyActivityTarget,
  dailyMessageTarget,
  dailyNotificationSlots,
  dailyWorldWeather,
  dailyNotificationTargetIndex,
  autonomyPacingDirective,
  autonomyHeartbeatTickId,
  isDuplicateEvent,
  isImageDiagnosticEvent,
  isTimerEvent,
  nextActivityDelayMinutes,
  violatesAutonomyPacing,
  deliverAutonomyNotification,
  isAutonomyOutboxRetryable,
  replayAutonomyNotifications,
} from "../scf-runtime/processor/autonomy.js";
import { localDate, localTimeContext } from "../scf-runtime/shared/agent.js";
import {
  chooseGalleryAsset,
  chooseReferenceAssets,
  choosePhotoPlanReferenceAssets,
  createImageTask,
  analyzeImage,
  generateImage,
  imageProviderConfig,
  visionProviderConfig,
} from "../scf-runtime/shared/media.js";
import { autonomyTimerDiagnostic } from "../scf-runtime/processor/index.js";
import {
  autonomyNotificationOutbox,
  autonomyNotificationOutboxKey,
} from "../scf-runtime/processor/autonomy.js";

function outboxMemoryStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async getJson(key, fallback = null) { return values.has(key) ? values.get(key) : fallback; },
    async putJson(key, value) { values.set(key, structuredClone(value)); },
    async getObject(key) {
      if (!values.has(key)) throw new Error(`Missing object: ${key}`);
      return { body: Buffer.from(values.get(key)), contentType: "image/png" };
    },
    async listKeys(prefix, limit = 100) {
      return [...values.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit);
    },
  };
}

describe("SCF autonomous heartbeat", () => {
  it("recognizes Tencent timer events", () => {
    expect(isTimerEvent({ Type: "Timer", TriggerName: "agent-heartbeat" })).toBe(true);
    expect(isTimerEvent({ Records: [] })).toBe(false);
  });

  it("derives a stable heartbeat identity from the Tencent timer timestamp", () => {
    const event = {
      Type: "Timer",
      TriggerName: "agent-heartbeat",
      Time: "2026-08-09T02:30:00.000Z",
    };
    expect(autonomyHeartbeatTickId(event, new Date("2026-08-09T02:31:00.000Z"))).toBe(
      "agent-heartbeat-202608090230",
    );
    expect(autonomyHeartbeatTickId(event, new Date("2026-08-09T02:59:59.000Z"))).toBe(
      "agent-heartbeat-202608090230",
    );
  });

  it("falls back to distinct deterministic half-hour heartbeat buckets", () => {
    expect(autonomyHeartbeatTickId({}, new Date("2026-08-09T02:31:00.000Z"))).toBe(
      "heartbeat-202608090230",
    );
    expect(autonomyHeartbeatTickId({}, new Date("2026-08-09T03:01:00.000Z"))).toBe(
      "heartbeat-202608090300",
    );
  });

  it("recognizes the token-protected image diagnostic event", () => {
    expect(isImageDiagnosticEvent({ Type: "ImageDiagnostic" })).toBe(true);
    expect(isImageDiagnosticEvent({ Type: "Timer" })).toBe(false);
  });

  it("records a durable successful timer health snapshot", () => {
    const diagnostic = autonomyTimerDiagnostic(
      { Type: "Timer", TriggerName: "agent-heartbeat" },
      { ok: true, skipped: "not_due", next_activity_at: "2026-08-09T03:00:00.000Z" },
      null,
      new Date("2026-08-09T02:30:00.000Z"),
    );
    expect(diagnostic).toMatchObject({
      error_key: null,
      error_record: null,
      health: {
        status: "ok",
        trigger_name: "agent-heartbeat",
        invoked_at: "2026-08-09T02:30:00.000Z",
        result: { skipped: "not_due" },
      },
    });
  });

  it("creates a timestamped autonomy error record without exposing the timer payload", () => {
    const diagnostic = autonomyTimerDiagnostic(
      { Type: "Timer", TriggerName: "agent heartbeat / prod", secret: "do-not-store" },
      null,
      new Error("DeepSeek request timed out"),
      new Date("2026-08-09T02:30:00.000Z"),
    );
    expect(diagnostic.error_key).toBe("errors/autonomy/20260809023000000-agent-heartbeat-prod.json");
    expect(diagnostic.health).toMatchObject({
      status: "failed",
      trigger_name: "agent-heartbeat-prod",
      error: "DeepSeek request timed out",
      result: null,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("do-not-store");
  });

  it("creates a durable notification outbox after the life event has an id", () => {
    const key = autonomyNotificationOutboxKey("2026-08-09", "event-123");
    const outbox = autonomyNotificationOutbox({
      eventId: "event-123",
      localDate: "2026-08-09",
      recipient: "ou_owner",
      message: "我刚才去了院子。",
      imageKey: "generated/2026-08-09/event-123.png",
      reason: "scheduled_daily_multiple",
      nowIso: "2026-08-09T03:00:00.000Z",
    });
    expect(key).toBe("outbox/notifications/2026-08-09/event-123.json");
    expect(outbox).toMatchObject({
      event_id: "event-123",
      correlation_id: "event-123",
      status: "pending",
      text_status: "pending",
      image_status: "pending",
      attempt_count: 0,
      generated_image_key: "generated/2026-08-09/event-123.png",
      local_date: "2026-08-09",
    });
  });

  it("retries a failed text delivery without losing the committed life event", async () => {
    const key = autonomyNotificationOutboxKey("2026-08-09", "event-retry");
    const outbox = autonomyNotificationOutbox({
      eventId: "event-retry",
      localDate: "2026-08-09",
      recipient: "ou_owner",
      message: "我去了花店。",
      nowIso: "2026-08-09T02:00:00.000Z",
    });
    const store = outboxMemoryStore({
      [key]: outbox,
      "events/2026-08-09/event-retry.json": { id: "event-retry", narrative: "我去了花店。" },
      "state/autonomy.json": { daily_date: "2026-08-09", daily_message_count: 0 },
    });
    let calls = 0;
    const sendText = async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary Feishu outage");
    };

    const failed = await deliverAutonomyNotification(store, key, outbox, {}, {
      now: new Date("2026-08-09T02:01:00.000Z"),
      sendText,
    });
    expect(failed).toMatchObject({ status: "failed", attempt_count: 1, text_status: "pending" });
    expect(store.values.get("events/2026-08-09/event-retry.json")).toMatchObject({ id: "event-retry" });
    expect(store.values.get("state/autonomy.json").daily_message_count).toBe(0);

    const sent = await deliverAutonomyNotification(store, key, failed, {}, {
      now: new Date("2026-08-09T02:17:00.000Z"),
      sendText,
    });
    expect(sent).toMatchObject({ status: "sent", text_status: "sent", attempt_count: 2 });
    expect(store.values.get("state/autonomy.json")).toMatchObject({
      daily_message_count: 1,
      counted_notification_ids: ["event-retry"],
    });

    await deliverAutonomyNotification(store, key, sent, {}, {
      now: new Date("2026-08-09T02:30:00.000Z"),
      sendText,
    });
    expect(calls).toBe(2);
    expect(store.values.get("state/autonomy.json").daily_message_count).toBe(1);
  });

  it("replays only the failed image delivery and reuses the generated COS object", async () => {
    const key = autonomyNotificationOutboxKey("2026-08-09", "event-image");
    const imageObjectKey = "generated/2026-08-09/event-image.png";
    const outbox = autonomyNotificationOutbox({
      eventId: "event-image",
      localDate: "2026-08-09",
      recipient: "ou_owner",
      message: "我拍到了院子里的花。",
      imageKey: imageObjectKey,
      nowIso: "2026-08-09T03:00:00.000Z",
    });
    const store = outboxMemoryStore({
      [key]: outbox,
      [imageObjectKey]: "already-generated-image-bytes",
      "state/autonomy.json": { daily_date: "2026-08-09", daily_message_count: 0 },
    });
    let textCalls = 0;
    let uploadCalls = 0;
    let imageCalls = 0;
    const sendText = async () => { textCalls += 1; };
    const uploadImage = async (body) => {
      uploadCalls += 1;
      expect(body.toString()).toBe("already-generated-image-bytes");
      if (uploadCalls === 1) throw new Error("temporary upload outage");
      return "img_feishu_key";
    };
    const sendImage = async () => { imageCalls += 1; };

    const partial = await deliverAutonomyNotification(store, key, outbox, {}, {
      now: new Date("2026-08-09T03:01:00.000Z"), sendText, uploadImage, sendImage,
    });
    expect(partial).toMatchObject({ status: "partial_failure", text_status: "sent", image_status: "failed" });

    const completed = await deliverAutonomyNotification(store, key, partial, {}, {
      now: new Date("2026-08-09T03:17:00.000Z"), sendText, uploadImage, sendImage,
    });
    expect(completed).toMatchObject({ status: "sent", text_status: "sent", image_status: "sent" });
    expect({ textCalls, uploadCalls, imageCalls }).toEqual({ textCalls: 1, uploadCalls: 2, imageCalls: 1 });
    expect(store.values.get("state/autonomy.json").daily_message_count).toBe(1);
  });

  it("respects active delivery leases and retries expired ones", () => {
    const now = new Date("2026-08-09T04:00:00.000Z");
    const base = { event_id: "event-lease", recipient: "ou_owner", status: "sending", attempt_count: 1 };
    expect(isAutonomyOutboxRetryable({ ...base, lease_until: "2026-08-09T04:05:00.000Z" }, now)).toBe(false);
    expect(isAutonomyOutboxRetryable({ ...base, lease_until: "2026-08-09T03:55:00.000Z" }, now)).toBe(true);
  });

  it("bounds each heartbeat outbox replay batch", async () => {
    const store = outboxMemoryStore({
      "state/autonomy.json": { daily_date: "2026-08-09", daily_message_count: 0 },
    });
    for (const id of ["a", "b", "c"]) {
      const key = autonomyNotificationOutboxKey("2026-08-09", id);
      store.values.set(key, autonomyNotificationOutbox({
        eventId: id,
        localDate: "2026-08-09",
        recipient: "ou_owner",
        message: id,
        nowIso: "2026-08-09T05:00:00.000Z",
      }));
    }
    let calls = 0;
    const result = await replayAutonomyNotifications(store, {
      AUTONOMY_OUTBOX_REPLAY_LIMIT: "2",
    }, {
      now: new Date("2026-08-09T05:01:00.000Z"),
      sendText: async () => { calls += 1; },
    });
    expect(result).toEqual({ checked: 3, replayed: 2 });
    expect(calls).toBe(2);
    expect(store.values.get("state/autonomy.json").daily_message_count).toBe(2);
  });

  it("uses bounded non-fixed activity scheduling", () => {
    expect(dailyActivityTarget("2026-07-23")).toBeGreaterThanOrEqual(6);
    expect(dailyActivityTarget("2026-07-23")).toBeLessThanOrEqual(8);
    const delay = nextActivityDelayMinutes("2026-07-23:1:event");
    expect(delay).toBeGreaterThanOrEqual(55);
    expect(delay).toBeLessThanOrEqual(130);
  });

  it("chooses one guaranteed notification slot within the daily activity target", () => {
    const date = "2026-07-24";
    expect(dailyNotificationTargetIndex(date)).toBeGreaterThanOrEqual(1);
    expect(dailyNotificationTargetIndex(date)).toBeLessThanOrEqual(dailyActivityTarget(date));
  });

  it("schedules two to four proactive contacts across separate daily activities", () => {
    const date = "2026-07-24";
    const activityTarget = dailyActivityTarget(date);
    const messageTarget = dailyMessageTarget(date);
    const slots = dailyNotificationSlots(date, messageTarget, activityTarget);
    expect(messageTarget).toBeGreaterThanOrEqual(2);
    expect(messageTarget).toBeLessThanOrEqual(4);
    expect(slots).toHaveLength(messageTarget);
    expect(new Set(slots).size).toBe(slots.length);
    expect(slots.every((slot) => slot >= 1 && slot <= activityTarget)).toBe(true);
  });

  it("supports a configurable fixed proactive-contact range", () => {
    expect(dailyMessageTarget("2026-07-24", 3, 3)).toBe(3);
  });

  it("gives the fictional town a stable but varied seasonal daily weather", () => {
    const first = dailyWorldWeather("2026-09-01", "初秋");
    expect(dailyWorldWeather("2026-09-01", "初秋")).toBe(first);
    const week = Array.from({ length: 7 }, (_, index) => dailyWorldWeather(`2026-09-0${index + 1}`, "初秋"));
    expect(new Set(week).size).toBeGreaterThan(1);
    expect(week.some((weather) => weather.includes("晴") || weather.includes("云") || weather.includes("风"))).toBe(true);
  });

  it("formats Shanghai dates consistently and exposes the real time period", () => {
    const now = new Date("2026-07-24T01:30:00.000Z");
    expect(localDate("Asia/Shanghai", now)).toBe("2026-07-24");
    expect(localTimeContext("Asia/Shanghai", now)).toMatchObject({ time: "09:30", period: "上午" });
  });

  it("detects an exact repeated autonomous event", () => {
    const event = { activity: "整理皮箱", narrative: "发现一本花草图册" };
    expect(isDuplicateEvent(event, [{ ...event }])).toBe(true);
    expect(isDuplicateEvent(event, [{ activity: "去早餐厅", narrative: "看见窗外的花" }])).toBe(false);
  });

  it("requires concrete town progress after repeated inn-bound events", () => {
    const recent = [
      { location: "云杉客栈二楼房间", activity: "在窗边看雨" },
      { location: "云杉客栈一楼早餐厅", activity: "翻花草图册" },
      { location: "云杉客栈院子", activity: "看湿叶子" },
    ];
    const directive = autonomyPacingDirective(recent, "云杉客栈院子");
    expect(directive.must_leave_inn).toBe(true);
    expect(violatesAutonomyPacing({ location: "云杉客栈门廊", activity: "等雨停" }, directive)).toBe(true);
    expect(violatesAutonomyPacing({ location: "小镇花店", activity: "第一次拜访花店" }, directive)).toBe(false);
  });
});

describe("replaceable media providers", () => {
  it("defaults to hybrid gallery generation and disabled vision", () => {
    expect(imageProviderConfig({}).mode).toBe("hybrid");
    expect(visionProviderConfig({}).mode).toBe("disabled");
  });

  it("reuses the Bailian workspace and key for replaceable vision", () => {
    expect(visionProviderConfig({
      VISION_MODE: "api",
      ALIYUN_BAILIAN_WORKSPACE_ID: "ws-test",
      DASHSCOPE_API_KEY: "test-key",
    })).toMatchObject({
      mode: "api",
      provider: "openai-compatible",
      baseUrl: "https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.6-flash",
      apiKey: "test-key",
      thinkingMode: false,
    });
  });

  it("sends image input to Bailian vision with thinking disabled", async () => {
    const previousFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        choices: [{ message: { content: "一只松鼠站在旅馆窗边。" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await analyzeImage({
        imageUrl: "data:image/png;base64,AAAA",
        prompt: "客观描述图片。",
      }, {
        VISION_MODE: "api",
        ALIYUN_BAILIAN_WORKSPACE_ID: "ws-test",
        DASHSCOPE_API_KEY: "test-key",
      });
      expect(captured.url).toBe("https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
      expect(captured.body.model).toBe("qwen3.6-flash");
      expect(captured.body.enable_thinking).toBe(false);
      expect(captured.body.messages[0].content[0]).toEqual({
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAAA" },
      });
      expect(result).toEqual({ status: "analyzed", text: "一只松鼠站在旅馆窗边。" });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("matches gallery assets by event tags and avoids unrelated assets", () => {
    const manifest = { assets: [
      { id: "breakfast", cos_key: "media/gallery/breakfast.png", tags: ["旅馆", "早餐", "清晨"] },
      { id: "rain", cos_key: "media/gallery/rain.png", tags: ["街道", "雨夜", "散步"] },
    ] };
    const selected = chooseGalleryAsset(manifest, {
      location: "旅馆早餐厅",
      activity: "吃早餐",
      mood: "平静",
      photo_description: "清晨的第一视角早餐",
    });
    expect(selected?.id).toBe("breakfast");
  });

  it("creates a vertical manual image task", () => {
    const task = createImageTask({
      photo_description: "小云在旅馆窗边看雨",
      image_prompt_zh: "9:16竖屏",
      image_prompt_en: "vertical 9:16",
    }, {});
    expect(task.status).toBe("waiting_manual_generation");
    expect(task.aspect_ratio).toBe("9:16");
  });

  it("keeps the fixed identity sheet first and may add a matching style reference", () => {
    const manifest = { assets: [
      { id: "agent-character-reference", cos_key: "media/references/agent.jpeg", sendable: false, reference_roles: ["identity"] },
      { id: "room", cos_key: "media/gallery/room.png", sendable: false, reference_roles: ["character_style", "interior_style"], tags: ["旅馆", "房间"] },
      { id: "lake", cos_key: "media/gallery/lake.png", sendable: false, reference_roles: ["character_style", "world_style"], tags: ["湖边"] },
    ] };
    expect(chooseReferenceAssets(manifest, { location: "旅馆房间", activity: "写日记" }, 2)
      .map((asset) => asset.id)).toEqual(["agent-character-reference", "room"]);
  });

  it("does not force the full character sheet into a first-person document photo", () => {
    const manifest = { assets: [
      { id: "agent-character-reference", cos_key: "media/references/agent.jpeg", sendable: false, reference_roles: ["identity"] },
      { id: "pov", cos_key: "media/gallery/pov.png", sendable: false, viewpoint: "first_person", reference_roles: ["pov_style", "location"], tags: ["旅馆", "房间"] },
      { id: "hero", cos_key: "media/gallery/hero.png", sendable: false, reference_roles: ["character_style", "location"] },
    ] };
    const selected = choosePhotoPlanReferenceAssets(manifest, {
      request_type: "document",
      subject: "日记本上的铅笔草稿",
      location: "旅馆房间",
      agent_visible: false,
      reference_needs: ["pov_style", "location"],
    }, 2);
    expect(selected.map((entry) => entry.asset.id)).not.toContain("agent-character-reference");
    expect(selected).toEqual([{ asset: manifest.assets[1], role: "pov_style" }]);
  });

  it("prefers a single-Agent lifestyle ref for selfies instead of the multi-view identity sheet", () => {
    const manifest = { assets: [
      { id: "identity", cos_key: "media/references/agent.jpeg", sendable: false, reference_roles: ["identity"], tags: ["小云"] },
      { id: "selfie", cos_key: "media/gallery/selfie.png", sendable: false, reference_roles: ["selfie_style", "character_style"], tags: ["自拍", "小云"] },
      { id: "full-body", cos_key: "media/gallery/standing.png", sendable: false, reference_roles: ["character_style"], tags: ["小云", "站立"] },
    ] };
    const selected = choosePhotoPlanReferenceAssets(manifest, {
      request_type: "selfie",
      subject: "小云此刻的自拍",
      location: "早餐厅",
      agent_visible: true,
      characters: ["小云"],
      reference_needs: ["selfie_style", "identity"],
    }, 2);
    expect(selected.map((entry) => entry.asset.id)).toEqual(["selfie", "full-body"]);
    expect(selected.map((entry) => entry.role)).toEqual(["selfie_style", "character_style"]);
  });

  it("prioritizes a fixed supporting-character reference when that resident is in the shot", () => {
    const manifest = { assets: [
      { id: "agent", cos_key: "media/references/agent.jpeg", sendable: false, reference_roles: ["identity"] },
      { id: "room", cos_key: "media/gallery/room.png", sendable: false, reference_roles: ["location"], tags: ["旅馆"] },
      { id: "fox", cos_key: "media/references/fox.jpeg", sendable: false, reference_roles: ["supporting_character"], tags: ["客栈掌柜"] },
    ] };
    const selected = choosePhotoPlanReferenceAssets(manifest, {
      request_type: "scene",
      subject: "客栈掌柜擦拭早餐杯",
      location: "旅馆早餐厅",
      agent_visible: false,
      characters: ["客栈掌柜"],
      reference_needs: ["location"],
    }, 2);
    expect(selected[0]).toMatchObject({ asset: { id: "fox" }, role: "supporting_character" });
  });

  it("adapts automatic generation to the DashScope Wan synchronous API", async () => {
    const previousFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        request_id: "req-1",
        output: { choices: [{ message: { content: [{ type: "image", image: "https://example.com/agent.png" }] } }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await generateImage({
        prompt: "9:16 竖屏，小云在旅馆写日记",
        referenceImages: ["data:image/jpeg;base64,AAAA"],
      }, {
        IMAGE_MODE: "api",
        IMAGE_PROVIDER: "dashscope-wan",
        IMAGE_BASE_URL: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
        IMAGE_MODEL: "wan2.7-image-pro",
        IMAGE_API_KEY: "test-key",
        IMAGE_SIZE: "1152*2048",
      });
      expect(captured.url).toContain("/services/aigc/multimodal-generation/generation");
      expect(captured.body.input.messages[0].content[0]).toEqual({ image: "data:image/jpeg;base64,AAAA" });
      expect(captured.body.input.messages[0].content[1].text).toContain("9:16");
      expect(captured.body.input.messages[0].content[1].text).toContain("不得直接复制旧照片");
      expect(captured.body.input.messages[0].content[1].text).toContain("电影感柔和拟真");
      expect(captured.body.input.messages[0].content[1].text).toContain("柔软、细腻、哑光");
      expect(captured.body.input.messages[0].content[1].text).toContain("只有一只松鼠");
      expect(captured.body.parameters).toMatchObject({ size: "1152*2048", n: 1 });
      expect(captured.body.parameters).not.toHaveProperty("prompt_extend");
      expect(result).toMatchObject({ status: "generated", url: "https://example.com/agent.png", request_id: "req-1" });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
