import { describe, expect, it } from "vitest";
import { parseIncomingMessage } from "../scf-runtime/shared/feishu.js";
import { imageBufferToDataUrl } from "../scf-runtime/shared/media.js";
import { assertSafePublicUrl, extractUrls, htmlToReadableText } from "../scf-runtime/shared/link-reader.js";

describe("SCF incoming content helpers", () => {
  it("parses Feishu text and image messages", () => {
    expect(parseIncomingMessage({ event: { message: { message_type: "text", content: JSON.stringify({ text: "@_user_1 你好" }) } } }))
      .toEqual({ type: "text", text: "你好" });
    expect(parseIncomingMessage({ event: { message: { message_type: "image", content: JSON.stringify({ image_key: "img_v2_abc" }) } } }))
      .toEqual({ type: "image", imageKey: "img_v2_abc" });
  });

  it("extracts, trims and deduplicates public URLs", () => {
    expect(extractUrls("看看 https://example.com/a，另一个 https://example.com/b). 再看 https://example.com/a", 5))
      .toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("rejects local and private network URLs", async () => {
    await expect(assertSafePublicUrl("http://localhost/private")).rejects.toThrow(/Local URLs/);
    await expect(assertSafePublicUrl("http://192.168.1.2/private")).rejects.toThrow(/Private or reserved/);
    await expect(assertSafePublicUrl("http://127.0.0.1/private")).rejects.toThrow(/Private or reserved/);
  });

  it("extracts readable HTML while removing executable content", () => {
    const result = htmlToReadableText(`
      <html><head><title>页面标题</title><meta name="description" content="页面简介"><style>.x{color:red}</style></head>
      <body><main><h1>主要内容</h1><script>ignore-me()</script><p>第一段 &amp; 第二段</p></main></body></html>
    `);
    expect(result.title).toBe("页面标题");
    expect(result.description).toBe("页面简介");
    expect(result.text).toContain("主要内容");
    expect(result.text).toContain("第一段 & 第二段");
    expect(result.text).not.toContain("ignore-me");
  });

  it("converts supported images to data URLs and rejects other media", () => {
    expect(imageBufferToDataUrl(Buffer.from([1, 2, 3]), "image/png"))
      .toBe("data:image/png;base64,AQID");
    expect(() => imageBufferToDataUrl(Buffer.from([1]), "application/octet-stream"))
      .toThrow(/Unsupported image content type/);
  });

  it("sniffs Feishu octet-stream images by file signature", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(imageBufferToDataUrl(jpeg, "application/octet-stream"))
      .toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
  });
});
