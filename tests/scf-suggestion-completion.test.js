import { describe, expect, it } from "vitest";
import { upsertUserSuggestionThreads, applyOpenThreadUpdates, bindSharedExperience, prioritizeOpenThreads } from "../scf-runtime/shared/open-threads.js";
const now = "2026-10-12T08:00:00Z";
function state(stance = "accepted") {
  return upsertUserSuggestionThreads({ items: [] }, [{ title: "吃碗小面", stance, suggested_by: "owner" }], { eventId: "chat", nowIso: now });
}
function event(s, narrative) {
  return { id: "life-event", occurred_at: now, selected_thread_id: s.items[0].id,
    activity: "在面馆吃小面", narrative, thread_updates: [{ thread_id: s.items[0].id, operation: "resolve" }] };
}
describe("suggestion intent, acceptance and result", () => {
  it.each(["我在面馆吃了一碗面。", "我去了面馆，吃了一碗面。", "我推门进去点了小面。我慢慢吃完，把碗推到一边。"])("closes equivalent completed meals with a result receipt: %s", (narrative) => {
    const s = state();
    s.items[0].content = "上次到了门口又没有进去，心里还惦记着那家店的玻璃";
    const e = event(s, narrative);
    const bound = bindSharedExperience(e, s);
    expect(bound.thread.id).toBe(s.items[0].id);
    const after = applyOpenThreadUpdates(s, e, bound.event.thread_updates, now);
    expect(after.items[0]).toMatchObject({ status: "closed", original_goal: "吃碗小面", last_result: { status: "succeeded", event_id: e.id } });
    expect(applyOpenThreadUpdates(after, e, e.thread_updates, now)).toEqual(after);
  });
  it.each(["我去了面馆，站在门口。", "我没有吃面。", "我明天准备吃面。", "老板吃完了面。", "我看着别人吃完面。", "我吃面失败了，店已经关门。", "我吃了一口面。", "我吃完了苹果。"])("does not confuse arrival, intention, failure or another actor with completion: %s", (narrative) => {
    const s = state(); const e = event(s, narrative);
    expect(bindSharedExperience(e, s).thread).toBeNull();
    expect(applyOpenThreadUpdates(s, e, e.thread_updates, now).items[0].status).toBe("active");
  });
  it("requires an explicit evidenced acceptance to reconsider a deferred suggestion", () => {
    const s = state("deferred"); const e = event(s, "我在面馆吃了一碗面。");
    expect(applyOpenThreadUpdates(s, e, e.thread_updates, now).items[0].stance).toBe("deferred");
    e.narrative = "我决定试试吃碗小面的建议。我在面馆吃了一碗面。";
    e.thread_updates[0].stance_change = { stance: "accepted", evidence: "我决定试试吃碗小面的建议" };
    expect(bindSharedExperience(e, s).thread).not.toBeNull();
    const after = applyOpenThreadUpdates(s, e, e.thread_updates, now);
    expect(after.items[0]).toMatchObject({ stance: "accepted", status: "closed", stance_evidence: { event_id: e.id, from: "deferred" } });
  });
  it("cannot reopen declined suggestions with a forged acceptance or change their source", () => {
    const s = state("declined"); const e = event(s, "我决定试试吃碗小面的建议。我在面馆吃了一碗面。");
    e.thread_updates[0].stance_change = { stance: "accepted", evidence: "我决定试试吃碗小面的建议" };
    e.thread_updates[0].source = "autonomy";
    expect(applyOpenThreadUpdates(s, e, e.thread_updates, now).items[0]).toMatchObject({ source: "user_suggestion", stance: "declined", status: "active" });
    expect(prioritizeOpenThreads(s)).toEqual([]);
  });
  it("updates an existing suggestion's stance on a later chat without merging different authors", () => {
    let s = state("deferred");
    s = upsertUserSuggestionThreads(s, [{ title: "吃碗小面", stance: "accepted", suggested_by: "owner" }], { eventId: "chat2", nowIso: now });
    expect(s.items).toHaveLength(1); expect(s.items[0].stance).toBe("accepted");
    s = upsertUserSuggestionThreads(s, [{ title: "吃碗小面", stance: "declined", suggested_by: "other" }], { eventId: "chat3", nowIso: now });
    expect(s.items).toHaveLength(2);
    expect(new Set(s.items.map((x) => x.id)).size).toBe(2);
  });
});
