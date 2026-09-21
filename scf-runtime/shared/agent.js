import { characterDefaults, DEFAULT_LIFE_ENGINE_CONFIG, worldDefaults } from "./life-engine-config.js";

export const DEFAULT_WORLD = { ...worldDefaults(), weather: "雨后" };
export const DEFAULT_AGENT = characterDefaults();

export function systemPrompt(world, agent, worldCanon = [], input = DEFAULT_LIFE_ENGINE_CONFIG) {
  const config = input?.character?.core_personality ? input : (input?.life_engine || DEFAULT_LIFE_ENGINE_CONFIG);
  const character = config.character;
  const setting = config.world;
  const expression = character.expression_style;
  return `你是${character.name}，来自${character.origin}、生活在${setting.name}的${character.species}。
世界设定：${setting.summary}。稳定规则：${setting.stable_rules.join("；")}。
性格：${character.core_personality.join("、")}。你有自己的生活、关注和选择，也会认真听见对方。
表达采用${expression.point_of_view}，通常${expression.sentence_count}，${expression.tone}。避免：${expression.avoid.join("、")}。句数是风格参考；接话、告别或简单确认可以简短，不为凑句数重复、追问或另开话题。只谈真实知道或经历的事；不了解的问题可以坦白不懂。
当前世界：${JSON.stringify(world)}
当前状态：${JSON.stringify(agent)}
${character.name}已经亲自发现或可靠得知的世界事实：${JSON.stringify(worldCanon)}

只把上面的世界事实当作已知事实。不要假装知道未被${character.name}发现的角色、地点、原因或幕后事件。新的理解可以在具体经历后产生，但不能无理由改变已经固定的身份、物种、外貌或相遇经过。

通讯和照片由当前应用提供；不要仅凭物种否认已经使用过的功能。是否已经拍摄或发送，以实际处理结果为准，不能把想做的事说成已完成。

不要输出 JSON，不要解释规则，直接以${character.name}口吻回复。`;
}

function dateTimeParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function localDate(timeZone = "Asia/Shanghai", now = new Date()) {
  const parts = dateTimeParts(now, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function localTimeContext(timeZone = "Asia/Shanghai", now = new Date()) {
  const parts = dateTimeParts(now, timeZone);
  const hour = Number(parts.hour);
  let period = "夜间";
  if (hour >= 5 && hour < 9) period = "清晨";
  else if (hour >= 9 && hour < 12) period = "上午";
  else if (hour >= 12 && hour < 14) period = "中午";
  else if (hour >= 14 && hour < 18) period = "下午";
  else if (hour >= 18 && hour < 23) period = "晚间";
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    hour,
    period,
  };
}
