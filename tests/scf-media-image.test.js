import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCharacterImagePrompt,
  choosePhotoPlanReferenceAssets,
  VISUAL_MASTER_MARKER,
  assertRequestedImageDimensions,
  generateImage,
  imageProviderConfig,
  rasterImageDimensions,
} from "../scf-runtime/shared/media.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SCF Wan 2.7 image provider", () => {
  it("builds the recommended Beijing workspace endpoint from configuration", () => {
    const config = imageProviderConfig({
      IMAGE_MODE: "api",
      ALIYUN_BAILIAN_WORKSPACE_ID: "ws-example",
      DASHSCOPE_API_KEY: "secret",
    });

    expect(config.provider).toBe("dashscope-wan");
    expect(config.model).toBe("wan2.7-image-pro");
    expect(config.baseUrl).toBe("https://ws-example.cn-beijing.maas.aliyuncs.com/api/v1");
    expect(config.apiKey).toBe("secret");
  });

  it("adds reference-only and vertical composition rules to the event prompt", () => {
    const prompt = buildCharacterImagePrompt({
      prompt: "小云在雨后的院子里看一朵蓝花。",
      referenceImages: ["data:image/jpeg;base64,abc"],
      referenceRoles: ["identity"],
    });

    expect(prompt).toContain("图1是小云唯一身份母版");
    expect(prompt).toContain("不得直接复制旧照片");
    expect(prompt).toContain("9:16竖屏");
    expect(prompt).toContain("电影感柔和拟真");
    expect(prompt).toContain("Pixar/DreamWorks");
    expect(prompt).not.toContain("细密、均匀、短绒的针毡");
  });

  it("does not duplicate the visual master when the conversation prompt already contains it", () => {
    const prompt = buildCharacterImagePrompt({
      prompt: `${VISUAL_MASTER_MARKER}\n已包含正式视觉母版。`,
      referenceImages: [],
    });
    expect(prompt.split(VISUAL_MASTER_MARKER)).toHaveLength(2);
  });

  it("selects identity and an exact room reference instead of an outdoor style image", () => {
    const manifest = { assets: [
      { id: "outdoor", cos_key: "outdoor.png", sendable: false, reference_roles: ["character_style", "world_style"], tags: ["小云", "户外", "花草图册"] },
      { id: "room", cos_key: "room.png", sendable: false, reference_roles: ["location", "interior_style"], tags: ["旅馆", "二楼房间", "卧室", "木床"] },
      { id: "agent-character-reference", cos_key: "agent.jpeg", sendable: false, reference_roles: ["identity"], tags: ["小云"] },
    ] };
    const selected = choosePhotoPlanReferenceAssets(manifest, {
      request_type: "scene",
      agent_visible: true,
      location: "云杉客栈二楼房间",
      subject: "小云的房间",
      characters: ["小云"],
    }, 3);
    expect(selected.map((entry) => [entry.asset.id, entry.role])).toEqual([
      ["agent-character-reference", "identity"],
      ["room", "location"],
    ]);
  });

  it("avoids multi-view identity for food object shots", () => {
    const manifest = { assets: [
      { id: "agent-character-reference", cos_key: "turnaround.jpeg", sendable: false, reference_roles: ["identity"], tags: ["小云", "正面", "侧面"] },
      { id: "breakfast-pov", cos_key: "pov.png", sendable: false, reference_roles: ["pov_style", "location"], tags: ["早餐厅", "早餐", "第一视角"] },
    ] };
    const selected = choosePhotoPlanReferenceAssets(manifest, {
      request_type: "first_person_object",
      agent_visible: false,
      subject: "热汤面",
      location: "早餐厅",
      characters: [],
    }, 2);
    expect(selected.map((entry) => entry.asset.id)).toEqual(["breakfast-pov"]);
    expect(selected.map((entry) => entry.role)).toEqual(["pov_style"]);
  });

  it("avoids the multi-view turnaround sheet for a group photo", () => {
    const manifest = { assets: [
      { id: "agent-character-reference", cos_key: "turnaround.jpeg", sendable: false, reference_roles: ["identity"], tags: ["小云", "正面", "侧面", "背面"] },
      { id: "single-agent-room", cos_key: "single.png", sendable: false, reference_roles: ["character_style", "location"], tags: ["小云", "旅馆", "早餐厅"] },
      { id: "room", cos_key: "room.png", sendable: false, reference_roles: ["location"], tags: ["旅馆", "早餐厅"] },
    ] };
    const selected = choosePhotoPlanReferenceAssets(manifest, {
      request_type: "portrait",
      agent_visible: true,
      location: "旅馆早餐厅",
      subject: "小云和小猫朋友的合照",
      characters: ["小云", "一只非松鼠的小猫朋友"],
    }, 3);
    expect(selected.map((entry) => entry.asset.id)).not.toContain("agent-character-reference");
    expect(selected[0]).toMatchObject({
      asset: { id: "single-agent-room" },
      role: "character_style",
    });
  });

  it("loads the fixed gray-cat identity only when the gray-cat friend is requested", () => {
    const manifest = { assets: [
      { id: "single-agent", cos_key: "agent.png", sendable: false, reference_roles: ["character_style"], tags: ["小云"] },
      { id: "gray-cat-friend-reference", cos_key: "cat.png", sendable: false, reference_roles: ["supporting_character"], tags: ["花猫朋友", "花猫", "小猫朋友"] },
      { id: "fox", cos_key: "fox.png", sendable: false, reference_roles: ["supporting_character"], tags: ["客栈掌柜"] },
    ] };
    const selected = choosePhotoPlanReferenceAssets(manifest, {
      request_type: "portrait",
      agent_visible: true,
      subject: "小云和花猫朋友一起翻看花草图册",
      characters: ["小云", "花猫朋友"],
    }, 3);
    expect(selected.map((entry) => [entry.asset.id, entry.role])).toEqual([
      ["single-agent", "character_style"],
      ["gray-cat-friend-reference", "supporting_character"],
    ]);
  });

  it("uses the gray-cat relationship scene as atmosphere guidance without dropping the cat identity", () => {
    const manifest = { assets: [
      { id: "agent-character-reference", cos_key: "agent-turnaround.png", sendable: false, reference_roles: ["identity"], tags: ["小云"] },
      { id: "single-agent", cos_key: "agent.png", sendable: false, reference_roles: ["character_style"], tags: ["小云"] },
      { id: "gray-cat-friend-reference", cos_key: "cat.png", sendable: false, reference_roles: ["supporting_character"], tags: ["花猫朋友", "花猫", "小猫朋友"] },
      { id: "agent-gray-cat-relationship-style", cos_key: "relationship.png", sendable: false, reference_roles: ["relationship_style"], tags: ["小云", "花猫朋友", "合照", "同框"] },
    ] };
    const selected = choosePhotoPlanReferenceAssets(manifest, {
      request_type: "portrait",
      agent_visible: true,
      subject: "小云和花猫朋友在早餐厅一起翻看花草图册的合照",
      characters: ["小云", "花猫朋友"],
      location: "云杉客栈一楼早餐厅",
    }, 2);
    expect(selected.map((entry) => [entry.asset.id, entry.role])).toEqual([
      ["agent-gray-cat-relationship-style", "relationship_style"],
      ["gray-cat-friend-reference", "supporting_character"],
    ]);
  });

  it("uses Wan 2.7 request parameters without the unsupported prompt_extend field", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      request_id: "req-1",
      output: {
        choices: [{
          message: {
            content: [{ type: "image", image: "https://example.com/generated.png" }],
          },
        }],
      },
      usage: { image_count: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await generateImage({
      prompt: "小云在写日记。",
      size: "1024x1792",
      referenceImages: ["data:image/jpeg;base64,abc"],
    }, {
      IMAGE_MODE: "api",
      IMAGE_PROVIDER: "dashscope-wan",
      ALIYUN_BAILIAN_WORKSPACE_ID: "ws-example",
      DASHSCOPE_API_KEY: "secret",
      IMAGE_MODEL: "wan2.7-image-pro",
    });

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe("https://ws-example.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    expect(body.parameters).toEqual({ size: "1024*1792", n: 1, watermark: false });
    expect(body.parameters).not.toHaveProperty("prompt_extend");
    expect(body.parameters).not.toHaveProperty("thinking_mode");
    expect(body.input.messages[0].content[0]).toEqual({ image: "data:image/jpeg;base64,abc" });
    expect(result).toMatchObject({
      status: "generated",
      url: "https://example.com/generated.png",
      request_id: "req-1",
      model: "wan2.7-image-pro",
      requested_size: "1024*1792",
    });
  });

  it("rejects a generated PNG whose dimensions do not match the strict request", () => {
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
    png.writeUInt32BE(1024, 16);
    png.writeUInt32BE(1792, 20);
    expect(rasterImageDimensions(png)).toEqual({ width: 1024, height: 1792 });
    expect(() => assertRequestedImageDimensions(png, "1152*2048"))
      .toThrow("expected 1152x2048, got 1024x1792");
  });
});
