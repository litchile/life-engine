import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../scf-runtime/shared/ai.js", () => ({ generateJson: vi.fn(), generateReply: vi.fn() }));
vi.mock("../scf-runtime/shared/feishu.js", async (original) => ({ ...await original(), replyText: vi.fn(), sendImage: vi.fn(), uploadImage: vi.fn().mockResolvedValue("image") }));
vi.mock("../scf-runtime/shared/media.js", async (original) => ({ ...await original(), generateImage: vi.fn().mockResolvedValue({}), generatedImageToBuffer: vi.fn().mockResolvedValue({ body: Buffer.from("fake"), contentType: "image/png" }), analyzeImage: vi.fn() }));
import { generateJson } from "../scf-runtime/shared/ai.js";
import { generateImage, analyzeImage } from "../scf-runtime/shared/media.js";
import { replyText, sendImage } from "../scf-runtime/shared/feishu.js";
import { extractExplicitPhotoSubject, isExplicitPhotoRequest, fulfillChatPhotoRequest } from "../scf-runtime/processor/chat-photo.js";
import { resolveConversationFocus, photoSubjectContext } from "../scf-runtime/shared/conversation-focus.js";
import { processEnvelope } from "../scf-runtime/processor/index.js";
const now = new Date("2026-09-16T04:00:00Z");
const resolve = (text, extra = {}) => resolveConversationFocus({ text, now, extractSubject: extractExplicitPhotoSubject, ...extra });
function store() {
  const data = new Map();
  return { data, getJson: async (k, fallback) => data.get(k) ?? fallback, putJson: async (k,v) => data.set(k,v), putObject: vi.fn(), exists: async (k) => data.has(k), tryAcquireLock: async () => true, releaseLock: async () => {} };
}
beforeEach(() => { vi.clearAllMocks(); });
describe("conversation attention and photo execution", () => {
  it.each(["看四叶草书签的照片", "你把四叶草书签拍给我看看", "拍一张四叶草书签照片给我看"])("extracts the actual requested object: %s", (text) => {
    expect(isExplicitPhotoRequest(text)).toBe(true);
    expect(extractExplicitPhotoSubject(text)).toBe("四叶草书签");
  });
  it("carries the shared object across the screenshot's two turns", () => {
    const focus = resolve("想看四叶草书签");
    expect(focus.subject).toBe("四叶草书签");
    expect(resolve("看看照片", { saved: focus }).subject).toBe("四叶草书签");
    expect(resolve("重新拍一张", { saved: focus }).subject).toBe("四叶草书签");
    expect(resolve("看热汤面的照片", { saved: focus }).subject).toBe("热汤面");
  });
  it("does not resurrect stale, cancelled or changed topics", () => {
    const focus = resolve("想看四叶草书签");
    expect(resolve("今天吃了什么", { saved: focus })).toBeNull();
    expect(resolve("不用拍照片", { saved: focus })).toBeNull();
    expect(isExplicitPhotoRequest("不要拍一张照片给我看")).toBe(false);
    expect(resolve("看看照片", { saved: { ...focus, updated_at: "2026-09-14T04:00:00Z" } })).toBeNull();
    expect(resolve("看看照片", { history: [{ role: "user", content: "想看四叶草书签" }, { role: "user", content: "今天吃了什么" }], lastContactAt: now.toISOString() })).toBeNull();
  });
  it("migrates the immediately previous user turn, not unrelated assistant photos", () => {
    const focus = resolve("看看照片", { history: [{ role: "user", content: "想看四叶草书签" }, { role: "assistant", content: "之前拍了热汤面" }], lastContactAt: now.toISOString() });
    expect(focus.subject).toBe("四叶草书签");
    expect(resolve("看看照片")).toBeNull();
  });
  it("separates committed object facts from dialogue embellishment", () => {
    const context = photoSubjectContext("四叶草书签", [{ story: "把四叶草书签夹进图鉴月见草那页" }, { story: "吃热汤面" }], [{ role: "assistant", content: "四叶草书签一直在箱底" }]);
    expect(context.life_facts).toHaveLength(1);
    expect(context.dialogue_claims).toHaveLength(1);
  });
  it("passes object provenance to planning and rendering, and honestly terminates failed review", async () => {
    generateJson.mockResolvedValue({ pass: false, reason: "主体变成活体植物" }).mockResolvedValueOnce({ subject: "四叶草书签", request_type: "first_person_object", agent_visible: false });
    analyzeImage.mockResolvedValue({ status: "analyzed", text: JSON.stringify({ pass: false, reason: "主体变成活体植物", actual_visual_summary: "一株植物" }) });
    const memory = store();
    const context = photoSubjectContext("四叶草书签", [{ story: "四叶草书签夹在图鉴月见草那页" }]);
    const result = await fulfillChatPhotoRequest({ store: memory, eventId: "review-fail", messageId: "msg", recipient: "user", userText: "拍一张四叶草书签照片给我看", world: {}, agent: { location: "房间" }, subjectContext: context, env: { IMAGE_MODE: "api", VISION_MODE: "api" }, now });
    expect(generateJson.mock.calls[0][1]).toContain("月见草那页");
    expect(generateImage.mock.calls[0][0].prompt).toContain("月见草那页");
    expect(result.status).toBe("semantic_review_failed");
    expect(result.retry_scheduled).toBe(false);
    expect(result.reply).toContain("四叶草书签");
    expect(result.reply).not.toContain("等我重新拍");
    expect(replyText).toHaveBeenCalledWith("msg", result.reply, expect.anything());
    expect(sendImage).not.toHaveBeenCalled();
    expect(generateImage).toHaveBeenCalledTimes(2);
  });
  it("runs the screenshot follow-up through the actual Feishu handler", async () => {
    const memory = store();
    memory.data.set("contacts/user.json", { last_contact_at: new Date().toISOString(), history: [
      { role: "user", content: "想看四叶草书签" },
      { role: "assistant", content: "四叶草书签夹在图鉴里" },
    ] });
    const result = await processEnvelope(memory, { header: { event_id: "followup" }, event: { sender: { sender_id: { open_id: "user" } }, message: { message_id: "msg", message_type: "text", content: JSON.stringify({ text: "看看照片" }) } } });
    // No API configuration: routing still reaches the camera, never generic chat.
    expect(result.photo).toBe("image_not_configured");
    expect(memory.data.get("contacts/user.json").conversation_focus.subject).toBe("四叶草书签");
    expect(memory.data.get("contacts/user.json").history.at(-1).content).toContain("相机现在还没有接好");
    expect(generateJson).not.toHaveBeenCalled();
  });
  it("clarifies a context-free follow-up without paying or borrowing another contact's photo", async () => {
    const memory = store();
    memory.data.set("state/recent-photo-plans.json", { plans: [{ recipient_key: "other", request_id: "private", subject: "热汤面", delivery_status: "sent", cos_key: "private.png" }] });
    const result = await processEnvelope(memory, { header: { event_id: "ambiguous" }, event: { sender: { sender_id: { open_id: "user" } }, message: { message_id: "msg", message_type: "text", content: JSON.stringify({ text: "看看照片" }) } } });
    expect(result.photo).toBe("needs_subject");
    expect(generateImage).not.toHaveBeenCalled();
    expect(sendImage).not.toHaveBeenCalled();
  });
  it("preserves the second image on delivery failure for a free resend", async () => {
    generateJson.mockResolvedValueOnce({ subject: "四叶草书签", request_type: "first_person_object", agent_visible: false })
      .mockResolvedValueOnce({ pass: false, reason: "主体缺失" }).mockResolvedValueOnce({ pass: true }).mockResolvedValueOnce({ caption: "拍好了。" });
    analyzeImage.mockResolvedValue({ status: "analyzed", text: "书签" });
    sendImage.mockRejectedValueOnce(new Error("delivery unavailable"));
    const memory = store();
    const result = await fulfillChatPhotoRequest({ store: memory, eventId: "second-image", messageId: "msg", recipient: "user", userText: "拍一张四叶草书签照片给我看", world: {}, agent: { location: "房间" }, env: { IMAGE_MODE: "api", VISION_MODE: "api" }, now });
    expect(result.status).toBe("delivery_failed");
    const record = memory.data.get("state/recent-photo-plans.json").plans.at(-1);
    expect(record.delivery_status).toBe("delivery_failed");
    expect(record.cos_key).toMatch(/-retry1.png$/);
    expect(memory.data.get(result.task_key).cos_key).toBe(record.cos_key);
    expect(result.reply).toContain("再发一次");
  });
});
