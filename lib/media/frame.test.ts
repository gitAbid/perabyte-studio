import { describe, expect, it } from "vitest";
import { refFromMediaUrl } from "@/lib/media/frame";

describe("refFromMediaUrl", () => {
  it("parses cache refs from media URLs", () => {
    expect(refFromMediaUrl("/api/media?f=abc.png")).toBe("abc.png");
    expect(refFromMediaUrl("https://app.test/api/media?f=a.jpg&download=1")).toBe("a.jpg");
  });

  it("returns null for provider URLs and empties", () => {
    expect(refFromMediaUrl("https://image.pollinations.ai/prompt/x")).toBeNull();
    expect(refFromMediaUrl(null)).toBeNull();
    expect(refFromMediaUrl("")).toBeNull();
  });
});
