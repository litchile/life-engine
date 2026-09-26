import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConversationPhotoPrompt,
  extractExplicitPhotoSubject,
  fallbackPhotoPlan,
  classifyPhotoIntent,
  isExplicitPhotoRequest,
  isMultiCharacterPhotoRequest,
  isPhotoAlreadySeenReminder,
  isPhotoContentCorrection,
  isPhotoDeliveryRetry,
  isPhotoRetakeRequest,
  normalizePhotoPlan,
  loadAvailablePhotoReferences,
  resolvePhotoRetryRecord,
  reviewGeneratedPhoto,
  sanitizeUnbackedPhotoClaim,
} from "../scf-runtime/processor/chat-photo.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("explicit chat photo requests", () => {
  it("binds a delivery follow-up to the newest request for the same recipient", () => {
    const plans = [
      {
        request_id: "old-pinecone",
        recipient_key: "ou_user_a",
        subject: "窗边松果",
        cos_key: "generated/pinecone.png",
        delivery_status: "sent",
      },
      {
        request_id: "current-cat-group",
        recipient_key: "ou_user_a",
        subject: "小云和小猫朋友的合照",
        cos_key: "generated/rejected-cat-group.png",
        delivery_status: "semantic_review_failed",
        visual_review_reason: "小猫朋友没有出现在画面中",
      },
    ];
    const result = resolvePhotoRetryRecord(plans, "ou_user_a");
    expect(result.status).toBe("latest_photo_not_resendable");
    expect(result.record.request_id).toBe("current-cat-group");
    expect(result.record.subject).toContain("小猫朋友");
  });

  it("never resends an unbound legacy photo or another recipient's image", () => {
    const plans = [
      { request_id: "legacy", cos_key: "generated/legacy.png", delivery_status: "sent" },
      {
        request_id: "other-user",
        recipient_key: "ou_user_b",
        cos_key: "generated/private.png",
        delivery_status: "sent",
      },
    ];
    expect(resolvePhotoRetryRecord(plans, "ou_user_a").status).toBe("no_bound_photo_request");
  });

  it("resends only the newest successfully saved request for that recipient", () => {
    const plans = [
      {
        request_id: "mine",
        recipient_key: "ou_user_a",
        cos_key: "generated/mine.png",
        delivery_status: "ready",
      },
      {
        request_id: "other",
        recipient_key: "ou_user_b",
        cos_key: "generated/other.png",
        delivery_status: "sent",
      },
    ];
    const result = resolvePhotoRetryRecord(plans, "ou_user_a");
    expect(result.status).toBe("resendable");
    expect(result.record.cos_key).toBe("generated/mine.png");
  });

  it.each([
    "拍一张照片给我看看",
    "给我拍张照片",
    "发一张照片给我看一下",
    "发个图片我看看",
    "来张自拍",
    "把窗边的小花拍下来给我看",
    "拍你画的月见草呀",
    "拍一张你画的铅笔草稿照片给我",
  ])("recognizes an authorized one-image request: %s", (text) => {
    expect(isExplicitPhotoRequest(text)).toBe(true);
  });

  it.each([
    "你会拍照吗",
    "你刚刚不是说学会拍照了吗",
    "昨天给我看了照片呢",
    "你拍给我看过了呀",
    "这张已经拍给我看过了",
    "照片去哪了",
    "今天在做什么",
  ])("does not charge for ordinary photo conversation: %s", (text) => {
    expect(isExplicitPhotoRequest(text)).toBe(false);
  });

  it("classifies already-seen, resend, retake and correction as distinct intents", () => {
    expect(classifyPhotoIntent("你拍给我看过了呀").intent).toBe("already_seen");
    expect(isPhotoAlreadySeenReminder("你拍给我看过了呀")).toBe(true);
    expect(classifyPhotoIntent("照片呢").intent).toBe("resend");
    expect(classifyPhotoIntent("重新拍一张四叶草书签").intent).toBe("retake");
    expect(isPhotoRetakeRequest("重新拍一张四叶草书签")).toBe(true);
    expect(classifyPhotoIntent("不是松果，是小猫朋友的合照呀", { hasRecentPhotoContext: true }).intent).toBe("correction");
    expect(classifyPhotoIntent("拍一张四叶草书签给我看").intent).toBe("new_request");
    // Retake wins over a bare delivery-retry phrase in the same sentence.
    expect(classifyPhotoIntent("照片呢，重新拍一张你和花猫朋友在窗边看花草图册的照片").intent).toBe("retake");
  });

  it("uses the reported dialogue as a photo-routing regression, not a new ledger", () => {
    const turns = [
      { user: "拍一张四叶草书签给我看", intent: "new_request", generates: true },
      { user: "你拍给我看过了呀", intent: "already_seen", generates: false },
      { user: "照片呢", intent: "resend", generates: false },
      { user: "重新拍一张四叶草书签", intent: "retake", generates: true },
      { user: "不是松果，是小猫朋友的合照呀", intent: "correction", generates: true, context: true },
      { user: "昨天给我看了照片呢", intent: "already_seen", generates: false },
    ];
    for (const turn of turns) {
      const classified = classifyPhotoIntent(turn.user, { hasRecentPhotoContext: Boolean(turn.context) });
      expect(classified.intent, turn.user).toBe(turn.intent);
      const generates = ["new_request", "retake", "correction"].includes(classified.intent);
      expect(generates, turn.user).toBe(turn.generates);
    }
  });

  it.each([
    "照片呢",
    "照片去哪了",
    "照片没有收到",
    "照片呢，倒是发呀小云",
    "没有呀，再发一次",
    "麻烦重新发一遍图片",
    "答应给我的照片呢？",
  ])("routes delivery follow-ups to a free resend instead of ordinary chat: %s", (text) => {
    expect(isPhotoDeliveryRetry(text)).toBe(true);
    expect(isExplicitPhotoRequest(text)).toBe(false);
  });

  it.each([
    "拍一张新的照片给我",
    "你会拍照吗",
    "这张照片很好看",
    "今天在做什么",
  ])("does not mistake unrelated text for a delivery retry: %s", (text) => {
    expect(isPhotoDeliveryRetry(text)).toBe(false);
  });

  it.each([
    "是小猫朋友的合照哦",
    "我要的是小猫朋友的合照",
    "不是松果，是小猫朋友的合照呀",
    "不对，应该是我们在早餐厅的照片",
  ])("recognizes a correction to the requested photo content: %s", (text) => {
    expect(isPhotoContentCorrection(text)).toBe(true);
  });

  it.each([
    "这是小猫朋友的合照哦",
    "小猫朋友今天来了吗",
    "这张照片挺好看的",
  ])("does not treat ordinary photo discussion as a correction request: %s", (text) => {
    expect(isPhotoContentCorrection(text)).toBe(false);
  });

  it("extracts the corrected subject instead of keeping the correction wording", () => {
    expect(extractExplicitPhotoSubject("是小猫朋友的合照哦")).toBe("小猫朋友的合照");
  });

  it("blocks text-only replies from pretending that a new photo was sent", () => {
    const reply = sanitizeUnbackedPhotoClaim("[小云展示了一张新的照片——画面里有小猫朋友。]");
    expect(reply).toContain("还没有真的把图片送出来");
    expect(reply).not.toContain("展示了一张新的照片");
    expect(sanitizeUnbackedPhotoClaim("那张照片里的光线很舒服。")).toBe("那张照片里的光线很舒服。");
  });

  it("keeps a requested drawing as a document subject instead of turning it into a real flower", () => {
    const plan = normalizePhotoPlan({
      request_type: "document",
      subject: "日记本里尚未完成的月见草石墨铅笔草稿",
      agent_visible: false,
      viewpoint: "小云低头拍摄的第一视角近景",
      must_show: ["纸张纹理", "石墨铅笔线条"],
      must_not_show: ["真实生长的月见草", "户外花园"],
      image_prompt_zh: "摊开的日记本上是一幅未完成的月见草铅笔草稿。",
    }, {
      userText: "拍一张你画的铅笔草稿照片给我",
      world: { weather: "夜晚" },
      agent: { location: "云杉客栈二楼房间" },
    });
    const prompt = buildConversationPhotoPrompt(plan);
    expect(plan.agent_visible).toBe(false);
    expect(prompt).toContain("石墨铅笔草稿");
    expect(prompt).toContain("真实生长的月见草");
    expect(prompt).toContain("第一视角");
    expect(prompt).toContain("1152×2048");
  });

  it("plans food and object requests as first-person shots without Agent or identity refs", () => {
    const plan = fallbackPhotoPlan({
      userText: "你记得拍一张热汤面给我看哦",
      world: { weather: "晴朗晚间" },
      agent: { location: "小镇青石路" },
    });
    expect(plan.request_type).toBe("first_person_object");
    expect(plan.agent_visible).toBe(false);
    expect(plan.characters).toEqual([]);
    expect(plan.reference_needs).not.toContain("identity");
    expect(plan.must_not_show.join(" ")).toMatch(/松鼠|小云/);
  });

  it("forces food shots away from identity even if the model asked for a Agent portrait", () => {
    const plan = normalizePhotoPlan({
      request_type: "scene",
      subject: "小云站在面碗前",
      agent_visible: true,
      characters: ["小云"],
      reference_needs: ["identity"],
      image_prompt_zh: "小云看着热汤面。",
    }, {
      userText: "拍一张热汤面给我看",
      world: { weather: "晴朗晚间" },
      agent: { location: "小杂货铺" },
    });
    expect(plan.request_type).toBe("first_person_object");
    expect(plan.agent_visible).toBe(false);
    expect(plan.reference_needs).toEqual(["pov_style", "location"]);
  });

  it("has a safe document fallback when structured planning is unavailable", () => {
    const plan = fallbackPhotoPlan({
      userText: "拍一张你刚才画的月见草铅笔草稿照片给我看。",
      world: { weather: "雨后初晴" },
      agent: { location: "云杉客栈二楼房间" },
    });
    expect(plan).toMatchObject({
      request_type: "document",
      agent_visible: false,
      location: "云杉客栈二楼房间",
    });
    expect(plan.subject).toContain("月见草铅笔草稿");
    expect(plan.must_show.join(" ")).toContain("石墨铅笔线条");
    expect(plan.must_not_show.join(" ")).toContain("现实物体");
    expect(plan.reference_needs).not.toContain("identity");
  });

  it("makes the current sentence's explicit subject authoritative", () => {
    expect(extractExplicitPhotoSubject("那你拍一张月亮给我看一下~")).toBe("月亮");
    const plan = normalizePhotoPlan({
      request_type: "scene",
      subject: "旅馆里的松鼠",
      must_show: ["木床"],
      image_prompt_zh: "小云站在房间里。",
    }, {
      userText: "那你拍一张月亮给我看一下~",
      world: { weather: "雨停后的夜晚" },
      agent: { location: "旅馆院子" },
    });
    expect(plan.subject).toBe("月亮");
    expect(plan.must_show).toContain("月亮");
    expect(plan.image_prompt_zh).toContain("明确纠正后的唯一主体是“月亮”");
    expect(plan.image_prompt_zh).not.toContain("小云站在房间里");
  });

  it("states that reference images are identity-only and cannot be reused as composition", () => {
    const prompt = buildConversationPhotoPrompt(normalizePhotoPlan({
      request_type: "scene",
      subject: "月亮",
      image_prompt_zh: "庭院上方刚升起的月亮。",
    }, {
      userText: "拍一张月亮给我看",
      world: { weather: "晴朗夜晚" },
      agent: { location: "旅馆院子" },
    }));
    expect(prompt).toContain("全新生活照片");
    expect(prompt).toContain("不是任何旧照片");
    expect(prompt).toContain("禁止沿用参考图的构图");
  });

  it("forces an explicit selfie into a true front-camera close-up without a visible phone", () => {
    const plan = normalizePhotoPlan({
      request_type: "scene",
      subject: "小云站在窗边",
      viewpoint: "第三人称全身照",
      composition: "完整站立",
      props: ["手机", "松果"],
      characters: ["小云", "摄影师"],
      image_prompt_zh: "小云拿着手机站在窗边。",
    }, {
      userText: "那你现在拍一张自拍给我",
      world: { weather: "晴朗清晨" },
      agent: { location: "旅馆早餐厅" },
    });
    const prompt = buildConversationPhotoPrompt(plan);
    expect(plan.request_type).toBe("selfie");
    expect(plan.characters).toEqual(["小云"]);
    expect(plan.props).toEqual(["松果"]);
    expect(plan.reference_needs).toEqual(["selfie_style", "identity"]);
    expect(plan.viewpoint).toContain("前置摄像头");
    expect(plan.must_not_show.join(" ")).toContain("手机");
    expect(prompt).toContain("脸和上半身");
    expect(prompt).toContain("拍摄设备在画外");
    expect(prompt).toContain("柔软细腻哑光");
    expect(prompt).not.toContain("细密、均匀、短绒的针毡");
    expect(prompt).toContain("只有一只松鼠");
  });

  it("turns an explicit room request into an indoor shot contract even when Agent is elsewhere", () => {
    const plan = normalizePhotoPlan({
      request_type: "scene",
      subject: "早餐厅窗边的小云",
      location: "旅馆早餐厅",
      agent_visible: true,
      image_prompt_zh: "小云坐在早餐厅。",
    }, {
      userText: "拍一张你的房间给我看看",
      world: { weather: "晴朗上午" },
      agent: { location: "旅馆早餐厅" },
    });
    const prompt = buildConversationPhotoPrompt(plan);
    expect(plan.location).toBe("云杉客栈二楼房间");
    expect(plan.current_location).toBe("旅馆早餐厅");
    expect(plan.capture_timing).toBe("after_move");
    expect(plan.must_show).toEqual(expect.arrayContaining(["木床", "窗户", "棕色旧背包"]));
    expect(plan.must_not_show.join(" ")).toContain("庭院");
    expect(plan.reference_needs).toContain("location");
    expect(prompt).toContain("最高优先级：镜头事实合同");
    expect(prompt).toContain("先自然移动到“云杉客栈二楼房间”后再拍摄");
    expect(prompt).toContain("若参考图地点与目标地点冲突，必须完全忽略");
  });

  it("collapses every squirrel-like planned character into the single identity Agent", () => {
    const plan = normalizePhotoPlan({
      request_type: "scene",
      subject: "小云和镇民在早餐厅",
      agent_visible: true,
      characters: ["小云", "另一只松鼠", "松鼠店员", "客栈掌柜", "兔子客人"],
      image_prompt_zh: "早餐厅里的自然生活瞬间。",
    }, {
      userText: "让客栈掌柜帮你拍一张现在的照片",
      world: { weather: "晴朗清晨" },
      agent: { location: "旅馆早餐厅" },
    });
    expect(plan.characters).toEqual(["小云", "客栈掌柜", "兔子客人"]);
    expect(plan.must_not_show.join(" ")).toContain("第二只松鼠");
    expect(buildConversationPhotoPrompt(plan)).toContain("其他居民不得使用这一物种");
  });

  it("turns a corrected cat-friend group photo into a strict two-character portrait", () => {
    const plan = normalizePhotoPlan({
      request_type: "scene",
      subject: "窗边的松果",
      agent_visible: false,
      characters: [],
      image_prompt_zh: "窗台上有一颗松果。",
    }, {
      userText: "不是松果，我要的是小云和小猫朋友的合照",
      world: { weather: "雨后初晴", local_time: "16:30", local_period: "下午" },
      agent: { location: "旅馆早餐厅" },
    });
    const prompt = buildConversationPhotoPrompt(plan);
    expect(plan.request_type).toBe("portrait");
    expect(plan.agent_visible).toBe(true);
    expect(plan.characters).toEqual(["小云", "一只非松鼠的小猫朋友"]);
    expect(plan.must_show.join(" ")).toContain("小猫朋友");
    expect(plan.must_not_show.join(" ")).toContain("单人照");
    expect(prompt).toContain("必须恰好清楚呈现2个指定主要角色");
    expect(prompt).toContain("小云、一只非松鼠的小猫朋友");
    expect(prompt).not.toContain("窗台上有一颗松果");
    expect(prompt).toContain("16:30（下午）");
  });

  it("treats shared activity and two-visible-character wording as a group portrait", () => {
    const userText = "请现在拍一张照片给我看看：画面是你和花猫朋友仍在刚才的窗边，一起翻看花草图册。不要使用旧照片，两位都要清楚出现在同一画面里。";
    expect(isMultiCharacterPhotoRequest(userText)).toBe(true);
    expect(extractExplicitPhotoSubject(userText)).toBe("你和花猫朋友仍在刚才的窗边，一起翻看花草图册");
    const plan = fallbackPhotoPlan({
      userText,
      world: { weather: "雨后空气清透", local_time: "17:58", local_period: "下午" },
      agent: { location: "云杉客栈一楼早餐厅" },
    });
    const prompt = buildConversationPhotoPrompt(plan);
    expect(plan).toMatchObject({
      request_type: "portrait",
      agent_visible: true,
      characters: ["小云", "花猫朋友"],
      props: ["花草图册"],
      required_character_count: 2,
    });
    expect(plan.agent_action).toContain("一起翻看");
    expect(plan.must_show.join(" ")).toContain("2个角色");
    expect(prompt).toContain("花猫朋友");
    expect(prompt).toContain("摊开的花草图册");
    expect(prompt).not.toContain("石墨铅笔");
    expect(prompt).not.toContain("第一视角物品照，物品占据");
  });

  it("skips a stale missing COS reference but keeps available references in role order", async () => {
    const store = {
      getObject: vi.fn(async (key) => {
        if (key === "missing.png") {
          const error = new Error("The specified key does not exist.");
          error.code = "NoSuchKey";
          error.statusCode = 404;
          throw error;
        }
        return { body: Buffer.from([1, 2, 3]), contentType: "image/png" };
      }),
    };
    const result = await loadAvailablePhotoReferences(store, [
      { asset: { id: "missing-location", cos_key: "missing.png" }, role: "location" },
      { asset: { id: "cat", cos_key: "cat.png" }, role: "supporting_character" },
    ]);
    expect(result.available.map((entry) => entry.asset.id)).toEqual(["cat"]);
    expect(result.referenceRoles).toEqual(["supporting_character"]);
    expect(result.referenceImages[0]).toMatch(/^data:image\/png;base64,/);
    expect(result.skipped).toEqual([expect.objectContaining({
      asset_id: "missing-location",
      reason: "cos_object_missing",
    })]);
  });

  it("does not force an ordinary current-life photo into selfie mode", () => {
    const plan = normalizePhotoPlan({
      request_type: "portrait",
      subject: "小云在早餐厅窗边的生活照",
      viewpoint: "客栈掌柜从桌子另一侧拍摄的第三人称半身视角",
      characters: ["小云"],
      image_prompt_zh: "客栈掌柜替小云拍下早餐厅里的自然半身照。",
    }, {
      userText: "拍张你现在的照片给我",
      world: { weather: "晴朗清晨" },
      agent: { location: "旅馆早餐厅" },
    });
    expect(plan.request_type).toBe("portrait");
    expect(plan.viewpoint).toContain("第三人称");
    expect(plan.must_not_show.join(" ")).not.toContain("自拍杆");
  });

  it("blocks a generated photo when visual review finds the requested subject missing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("vision.example")) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "画面主体是一只站在旅馆房间里的松鼠，没有月亮。" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          pass: false,
          reason: "用户要求的月亮没有出现",
          observed_subject: "松鼠",
          observed_location: "旅馆房间",
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const review = await reviewGeneratedPhoto({
      downloaded: { body: Buffer.from([1, 2, 3]), contentType: "image/png" },
      plan: {
        user_text: "拍一张月亮给我看",
        requested_subject: "月亮",
        subject: "月亮",
        request_type: "scene",
        location: "旅馆院子",
        must_show: ["月亮"],
        must_not_show: [],
      },
      env: {
        VISION_MODE: "api",
        VISION_PROVIDER: "openai-compatible",
        VISION_BASE_URL: "https://vision.example/v1",
        VISION_MODEL: "qwen-vl-plus",
        VISION_API_KEY: "vision-key",
        AI_BASE_URL: "https://text.example/v1",
        AI_API_KEY: "text-key",
        AI_MODEL: "deepseek-chat",
      },
    });
    expect(review).toMatchObject({
      status: "reviewed",
      pass: false,
      observed_subject: "松鼠",
      observed_location: "旅馆房间",
    });
    expect(review.actual_visual_summary).toContain("没有月亮");
  });
});
