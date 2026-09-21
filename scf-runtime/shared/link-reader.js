import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 10000;
const DEFAULT_REDIRECTS = 5;

export function extractUrls(text, maxUrls = 2) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"'，。！？；：（）【】]+/gi) || [];
  return [...new Set(matches.map((url) => url.replace(/[),.;!?，。！？；：）】]+$/u, "")))].slice(0, maxUrls);
}

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function isPrivateIp(address) {
  const normalized = String(address).toLowerCase();
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
}

export async function assertSafePublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Only http and https URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) throw new Error("Local URLs are not allowed");
  let addresses = [];
  if (isIP(hostname)) addresses = [hostname];
  else {
    const [v4, v6] = await Promise.all([
      resolve4(hostname).catch(() => []),
      resolve6(hostname).catch(() => []),
    ]);
    addresses = [...v4, ...v6];
  }
  if (!addresses.length) throw new Error("URL hostname could not be resolved");
  if (addresses.some(isPrivateIp)) throw new Error("Private or reserved network addresses are not allowed");
  url.hash = "";
  return url;
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) throw new Error("Linked content is too large");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Linked content is too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function decodeEntities(text) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, token) => {
    if (token[0] === "#") {
      const hex = token[1]?.toLowerCase() === "x";
      const value = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return entities[token.toLowerCase()] ?? match;
  });
}

export function htmlToReadableText(html, maxChars = DEFAULT_MAX_CHARS) {
  const source = String(html || "");
  const title = decodeEntities((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<[^>]+>/g, " ")).trim();
  const description = decodeEntities(source.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["']/i)?.[1]
    || source.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i)?.[1] || "").trim();
  const cleaned = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|article|section|main|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(cleaned).replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, description, text: text.slice(0, maxChars) };
}

export async function readPublicLink(rawUrl, env = process.env) {
  if ((env.LINK_READER_MODE || "enabled") === "disabled") return { status: "disabled", url: rawUrl };
  const maxBytes = Number(env.LINK_MAX_BYTES || DEFAULT_MAX_BYTES);
  const maxChars = Number(env.LINK_MAX_CHARS || DEFAULT_MAX_CHARS);
  const maxRedirects = Number(env.LINK_MAX_REDIRECTS || DEFAULT_REDIRECTS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.LINK_TIMEOUT_MS || 10000));
  try {
    let current = await assertSafePublicUrl(rawUrl);
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": "AgentLinkReader/1.0 (+personal Feishu assistant)",
          accept: "text/html,text/plain,application/json,image/*;q=0.8,*/*;q=0.2",
        },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect response had no location");
        if (redirects === maxRedirects) throw new Error("Too many redirects");
        current = await assertSafePublicUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new Error(`Linked page returned HTTP ${response.status}`);
      const contentType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].toLowerCase();
      const body = await readLimitedBody(response, maxBytes);
      if (contentType.startsWith("image/")) {
        return { status: "image", url: current.toString(), contentType, body };
      }
      if (contentType === "application/pdf") {
        return { status: "unsupported_pdf", url: current.toString(), contentType };
      }
      if (contentType.includes("html")) {
        return { status: "read", url: current.toString(), contentType, ...htmlToReadableText(body.toString("utf8"), maxChars) };
      }
      if (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml")) {
        return { status: "read", url: current.toString(), contentType, title: "", description: "", text: body.toString("utf8").slice(0, maxChars) };
      }
      return { status: "unsupported_type", url: current.toString(), contentType };
    }
    throw new Error("Link reader exhausted redirects");
  } finally {
    clearTimeout(timer);
  }
}
