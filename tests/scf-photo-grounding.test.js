import { describe, expect, it, vi } from "vitest";
vi.mock("../scf-runtime/shared/ai.js", () => ({ generateJson: vi.fn() }));
vi.mock("../scf-runtime/shared/media.js", async (original) => ({ ...await original(), analyzeImage: vi.fn() }));
import { generateJson } from "../scf-runtime/shared/ai.js";
import { analyzeImage, choosePhotoPlanReferenceAssets } from "../scf-runtime/shared/media.js";
import { photoSubjectContext } from "../scf-runtime/shared/conversation-focus.js";
import { buildConversationPhotoPrompt, photoAcceptanceContract, reviewGeneratedPhoto } from "../scf-runtime/processor/chat-photo.js";
const plan = {
  request_type: "first_person_object", agent_visible: false, characters: [],
  requested_subject: "四叶草书签", subject: "干枯四叶草书签特写",
  user_request: "拍一张四叶草书签照片给我看", location: "房间", weather: "阴天",
  must_show: ["必须斜插在书缝，只露一半"], must_not_show: ["平放的书签"],
  composition: "只露一半", image_prompt_zh: "必须斜插在书缝，只露一半",
  subject_context: { life_facts: [{ id: "e1", narrative: "四叶草书签夹在图鉴里。", internal_plan: { unrelated: "四叶草书签".repeat(20000) } }] },
};
describe("object photo grounding from observed failure", () => {
  it("projects only relevant primary event facts and never nested goal ledgers", () => {
    const context = photoSubjectContext("四叶草书签", [...plan.subject_context.life_facts, { narrative: "今天去了商店", internal_plan: { subject: "四叶草书签" } }]);
    expect(context.life_facts).toHaveLength(1);
    expect(context.life_facts[0].narrative).toBe("四叶草书签夹在图鉴里。");
    expect(JSON.stringify(context).length).toBeLessThan(1000);
    expect(JSON.stringify(context)).not.toContain("internal_plan");
  });
  it("does not make invented placement a rejection criterion", () => {
    const contract = photoAcceptanceContract(plan);
    expect(contract.must_show).toContain("四叶草书签");
    expect(JSON.stringify(contract)).not.toContain("只露一半");
    expect(contract.staging_is_optional).toBe(true);
    expect(photoAcceptanceContract({ ...plan, user_request: "请把书签斜插在书缝里拍" }).user_request).toContain("斜插");
  });
  it("uses a bounded object-focused prompt rather than the conflicting director draft", () => {
    const prompt = buildConversationPhotoPrompt(plan);
    expect(prompt.length).toBeLessThan(2500);
    expect(prompt).toContain("四叶草书签夹在图鉴里");
    expect(prompt).not.toContain("必须斜插在书缝，只露一半");
    expect(prompt).toContain("禁止任何文字");
    expect(prompt).toContain("不抄写书名");
  });
  it("does not attach bedroom and breakfast compositions to an isolated object", () => {
    const manifest = { assets: [{ id: "breakfast", enabled: true, sendable: false, cos_key: "ref.png", roles: ["pov_style"], tags: ["早餐"] }] };
    expect(choosePhotoPlanReferenceAssets(manifest, { ...plan, reference_policy: "object_closeup_without_scene_refs" })).toEqual([]);
  });
  it("keeps an invalid verifier response unknown instead of paying for another image", async () => {
    analyzeImage.mockResolvedValue({ status: "analyzed", text: "书页上有压干的叶片，数量看不清" });
    generateJson.mockResolvedValue({ reason: "无法确认" });
    const result = await reviewGeneratedPhoto({ downloaded: { body: Buffer.from("image"), contentType: "image/png" }, plan, env: { VISION_MODE: "api" } });
    expect(result.pass).toBeNull();
    expect(result.status).toBe("invalid_review");
    expect(analyzeImage.mock.calls.at(-1)[0].prompt).toContain("叶片数量");
    expect(generateJson.mock.calls.at(-1)[1]).not.toContain("只露一半");
  });
});
