import { describe, expect, it } from "vitest";
import {
  applyChatTurnToScene,
  deriveConversationCorrections,
  inferEnvironment,
  mergeConversationMemories,
  normalizeChatTurn,
  normalizeCurrentScene,
  reconcileSceneWithRealTime,
  retrieveRelevantMemories,
  touchRecalledMemories,
} from "../scf-runtime/shared/chat-memory.js";

describe("layered conversation memory and authoritative scene", () => {
  const world = { weather: "秋日晴朗" };
  const agent = { location: "云杉客栈二楼房间", activity: "画画", current_intention: "晚些时候去院子" };

  it("keeps one authoritative location when a turn does not complete a move", () => {
    const scene = normalizeCurrentScene({}, { world, agent, nowIso: "2026-07-28T12:00:00Z" });
    const turn = normalizeChatTurn({
      reply: "我还在房间里。晚一点想去院子看看。",
      scene_transition: { occurred: false, location: "旅馆院子" },
      new_intention: "晚一点去院子",
    }, scene);
    const next = applyChatTurnToScene(scene, turn, { eventId: "m1", nowIso: "2026-07-28T12:01:00Z", weather: world.weather });
    expect(next.location).toBe("云杉客栈二楼房间");
    expect(next.current_intention).toBe("晚一点去院子");
  });

  it("reconciles stale meal intentions with the real Shanghai time", () => {
    const scene = normalizeCurrentScene({
      location: "云杉客栈二楼房间",
      activity: "准备下楼吃早餐",
      current_intention: "现在去早餐厅",
    }, { world, agent });
    const reconciled = reconcileSceneWithRealTime(scene, { hour: 16, time: "16:30", period: "下午" });
    expect(reconciled).toMatchObject({
      local_time: "16:30",
      local_period: "下午",
      time_reconciled: true,
    });
    expect(reconciled.activity).not.toContain("早餐");
    expect(reconciled.current_intention).not.toContain("早餐厅");
  });

  it("keeps an explicitly future morning plan without treating it as happening now", () => {
    const scene = normalizeCurrentScene({
      current_intention: "明早去楼下看看早餐厅",
    }, { world, agent });
    const reconciled = reconcileSceneWithRealTime(scene, { hour: 16, time: "16:30", period: "下午" });
    expect(reconciled.current_intention).toBe("明早去楼下看看早餐厅");
    expect(reconciled.local_period).toBe("下午");
  });

  it("commits a completed contextual move and its indoor/outdoor state", () => {
    const scene = normalizeCurrentScene({}, { world, agent });
    const turn = normalizeChatTurn({
      reply: "我刚走到院子里。树叶上还有一点水。",
      scene_transition: {
        occurred: true,
        location: "云杉客栈院子",
        activity: "看雨后的树叶",
        present_characters: ["小云"],
        reason: "想透透气",
      },
    }, scene);
    const next = applyChatTurnToScene(scene, turn, { eventId: "m2", nowIso: "2026-07-28T12:02:00Z", weather: world.weather });
    expect(next).toMatchObject({ location: "云杉客栈院子", environment: "outdoors", activity: "看雨后的树叶" });
  });

  it("accepts an explicit scene correction without pretending it was a new journey", () => {
    const scene = normalizeCurrentScene({ location: "云杉客栈院子", environment: "outdoors" }, { world, agent });
    const turn = normalizeChatTurn({
      reply: "你说得对。刚才其实是在房间窗边画画。",
      scene_transition: {
        occurred: true,
        transition_type: "correction",
        location: "云杉客栈二楼房间",
        sub_location: "窗边木椅",
        environment: "indoors",
        activity: "修改月见草草稿",
        present_characters: ["小云"],
        reason: "用户纠正了错误的场景记录",
      },
    }, scene);
    const next = applyChatTurnToScene(scene, turn, { eventId: "m-correction", nowIso: "2026-07-28T12:02:30Z", weather: world.weather });
    expect(turn.scene_transition.transition_type).toBe("correction");
    expect(next).toMatchObject({ location: "云杉客栈二楼房间", environment: "indoors", activity: "修改月见草草稿" });
  });

  it("infers thresholds and deduplicates durable conversation memories", () => {
    expect(inferEnvironment("旅馆门廊")).toBe("threshold");
    const memories = mergeConversationMemories(
      [{ content: "小云答应修改月见草草稿", importance: 1 }],
      [{ content: "小云答应修改月见草草稿", importance: 3 }, { content: "明天去书店", importance: 2 }],
      "2026-07-28T12:03:00Z",
    );
    expect(memories).toHaveLength(2);
    expect(memories[0]).toMatchObject({ content: "小云答应修改月见草草稿", importance: 3 });
  });

  it("supersedes an older fact in the same semantic slot", () => {
    const memories = mergeConversationMemories(
      [{
        content: "小云现在在旅馆房间",
        kind: "fact",
        subject: "小云",
        predicate: "当前位置",
        importance: 3,
        status: "active",
        created_at: "2026-07-28T10:00:00Z",
      }],
      [{
        content: "小云现在在旅馆院子",
        kind: "fact",
        subject: "小云",
        predicate: "当前位置",
        importance: 3,
      }],
      "2026-07-28T12:00:00Z",
    );
    expect(memories).toHaveLength(2);
    expect(memories.find((item) => item.content.includes("房间"))?.status).toBe("superseded");
    expect(memories.find((item) => item.content.includes("院子"))?.status).toBe("active");
  });

  it("lets a high-priority user correction supersede an older fact across memory kinds", () => {
    const memories = mergeConversationMemories(
      [{
        content: "刚才那张照片是用户自己的房间",
        kind: "fact",
        subject: "最近照片",
        predicate: "描绘地点归属",
        importance: 2,
        status: "active",
      }],
      [{
        content: "用户纠正：刚才发送的参考图片描绘的是小云的房间，不是用户的房间",
        kind: "correction",
        subject: "最近照片",
        predicate: "描绘地点归属",
        importance: 1,
      }],
      "2026-07-29T08:00:00Z",
    );
    expect(memories.find((item) => item.kind === "fact")?.status).toBe("superseded");
    expect(memories.find((item) => item.kind === "correction")).toMatchObject({
      status: "active",
      importance: 3,
    });
  });

  it("recovers explicit room and camera corrections from recent dialogue", () => {
    const corrections = deriveConversationCorrections([
      { role: "assistant", content: "那个房间不是我的房间，可能是你的。" },
      { role: "user", content: "这就是你的房间，我发的图片是你的房间" },
      { role: "assistant", content: "我是一只松鼠，不会用手机拍照。" },
    ], "你会");
    expect(corrections).toHaveLength(2);
    expect(corrections).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "用户提供的房间参考图", kind: "correction", importance: 3 }),
      expect.objectContaining({ predicate: "拍摄与发送照片的能力", kind: "correction", importance: 3 }),
    ]));
  });

  it("locks Huahua's confirmed name and no-glasses appearance", () => {
    const corrections = deriveConversationCorrections([
      { role: "assistant", content: "花猫朋友扶了扶小圆眼镜。" },
      { role: "user", content: "她没有眼镜呀，你仔细看看" },
    ], "我们以后叫她花花好不好");
    expect(corrections).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "花花（花猫朋友）", predicate: "眼镜", kind: "correction" }),
      expect.objectContaining({ subject: "花花（花猫朋友）", predicate: "名字", content: "花花（花猫朋友）的名字已经确定为“花花”" }),
    ]));
  });

  it("does not attribute an ambiguous pronoun to a configured resident", () => {
    expect(deriveConversationCorrections([
      { role: "assistant", content: "她扶了扶小圆眼镜。" },
    ], "她没有眼镜呀")).toEqual([]);
  });

  it("resolves completed intentions instead of recalling them forever", () => {
    const memories = mergeConversationMemories(
      [{
        content: "小云准备去院子看月见草",
        kind: "intention",
        subject: "小云",
        predicate: "去院子看月见草",
        importance: 2,
        status: "active",
      }],
      [{
        operation: "resolve",
        content: "小云已经去院子看过月见草",
        kind: "intention",
        subject: "小云",
        predicate: "去院子看月见草",
      }],
      "2026-07-28T13:00:00Z",
    );
    expect(memories[0]).toMatchObject({ status: "resolved", resolved_at: "2026-07-28T13:00:00Z" });
  });

  it("retrieves memories related to the current topic and scene", () => {
    const memories = mergeConversationMemories([], [
      { content: "小云在院子里画过月见草草稿", kind: "episode", subject: "小云", predicate: "画月见草", tags: ["月见草", "院子"], importance: 2 },
      { content: "客栈掌柜每天早晨擦前台的杯子", kind: "fact", subject: "客栈掌柜", predicate: "早晨习惯", tags: ["前台"], importance: 2 },
      { content: "小云想去湖边寻找凉快的石头", kind: "intention", subject: "小云", predicate: "去湖边", tags: ["湖边"], importance: 1 },
    ], "2026-07-28T10:00:00Z");
    const recalled = retrieveRelevantMemories(memories, {
      query: "刚才画的月见草草稿还能给我看看吗",
      currentScene: { location: "旅馆院子", activity: "画画", current_intention: "修改月见草草稿" },
      limit: 2,
      nowIso: "2026-07-28T12:00:00Z",
    });
    expect(recalled[0].content).toContain("月见草草稿");
    const touched = touchRecalledMemories(memories, recalled.slice(0, 1), "2026-07-28T12:01:00Z");
    expect(touched.find((item) => item.id === recalled[0].id)).toMatchObject({ recall_count: 1, last_recalled_at: "2026-07-28T12:01:00Z" });
  });
});
