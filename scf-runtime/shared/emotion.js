const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, Number(value) || 0));

export function defaultEmotionState(nowIso = new Date().toISOString()) {
  return {
    schema_version: 1,
    long_term: {
      curiosity: 0.72,
      social_confidence: 0.24,
      belonging: 0.2,
      independence: 0.32,
    },
    current: {
      label: "平静中带一点好奇",
      valence: 0.18,
      arousal: 0.3,
      security: 0.42,
      energy: 0.58,
      cause: "正在当前环境慢慢安顿下来",
    },
    updated_at: nowIso,
  };
}

export function decayEmotionState(saved, nowIso = new Date().toISOString()) {
  const state = { ...defaultEmotionState(nowIso), ...(saved || {}) };
  state.long_term = { ...defaultEmotionState(nowIso).long_term, ...(saved?.long_term || {}) };
  state.current = { ...defaultEmotionState(nowIso).current, ...(saved?.current || {}) };
  const elapsedHours = Math.max(0, ((Date.parse(nowIso) || Date.now()) - (Date.parse(saved?.updated_at) || Date.parse(nowIso))) / 3_600_000);
  const recovery = Math.min(0.75, elapsedHours / 24);
  return {
    ...state,
    current: {
      ...state.current,
      valence: clamp(state.current.valence * (1 - recovery) + 0.18 * recovery, -1, 1),
      arousal: clamp(state.current.arousal * (1 - recovery) + 0.3 * recovery),
      security: clamp(state.current.security * (1 - recovery) + (0.35 + state.long_term.belonging * 0.35) * recovery),
      energy: clamp(state.current.energy * (1 - recovery) + 0.58 * recovery),
    },
    updated_at: nowIso,
  };
}

function moodSignal(text) {
  const value = String(text || "");
  if (/(开心|惊喜|满足|安心|温暖|高兴)/.test(value)) return { valence: 0.18, security: 0.08, arousal: 0.05 };
  if (/(害怕|紧张|担心|尴尬|不安|难过)/.test(value)) return { valence: -0.16, security: -0.1, arousal: 0.12 };
  if (/(困|疲惫|累)/.test(value)) return { valence: -0.02, security: 0, arousal: -0.12, energy: -0.18 };
  if (/(好奇|期待|发现|探索)/.test(value)) return { valence: 0.08, security: 0, arousal: 0.1, energy: 0.05 };
  return { valence: 0.02, security: 0.01, arousal: 0 };
}

export function applyEventToEmotion(saved, event, nowIso = new Date().toISOString()) {
  const state = decayEmotionState(saved, nowIso);
  const signal = moodSignal(`${event?.mood || ""} ${event?.activity || ""} ${event?.narrative || ""}`);
  const importance = Math.max(1, Math.min(5, Number(event?.importance || 1)));
  const weight = 0.45 + importance * 0.1;
  const explored = /(探索|第一次|发现|去了|走到|来到)/.test(`${event?.activity || ""} ${event?.narrative || ""}`);
  const social = Array.isArray(event?.world_observations)
    && event.world_observations.some((item) => item?.entity_type === "character");
  const longTerm = {
    ...state.long_term,
    curiosity: clamp(state.long_term.curiosity + (explored ? 0.006 : 0)),
    independence: clamp(state.long_term.independence + (explored ? 0.004 : 0)),
    social_confidence: clamp(state.long_term.social_confidence + (social ? 0.004 : 0)),
    belonging: clamp(state.long_term.belonging + (social || importance >= 4 ? 0.003 : 0)),
  };
  return {
    ...state,
    long_term: longTerm,
    current: {
      label: String(event?.mood || state.current.label),
      valence: clamp(state.current.valence + (signal.valence || 0) * weight, -1, 1),
      arousal: clamp(state.current.arousal + (signal.arousal || 0) * weight),
      security: clamp(state.current.security + (signal.security || 0) * weight),
      energy: clamp(state.current.energy + (signal.energy || 0) * weight),
      cause: String(event?.activity || event?.narrative || state.current.cause).slice(0, 160),
    },
    last_event_id: event?.id || event?.event_id || null,
    updated_at: nowIso,
  };
}

export function emotionForPrompt(state) {
  const value = state || defaultEmotionState();
  return {
    long_term_tendencies: value.long_term,
    current_mood: value.current,
    rule: "情绪来自角色与世界的经历，会随时间缓慢恢复；用户不联系不会造成惩罚、退化或情感勒索。",
  };
}
