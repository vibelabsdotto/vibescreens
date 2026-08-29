import { describe, expect, it } from "vitest";

import { rejectCrossSiteMultipartWrite } from "../request-guard";

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/upload-font", {
    method: "POST",
    headers,
  });
}

describe("rejectCrossSiteMultipartWrite", () => {
  it("allows multipart form writes from loopback origins", () => {
    expect(
      rejectCrossSiteMultipartWrite(
        request({
          "content-type": "multipart/form-data; boundary=abc123",
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBeNull();
  });

  it("requires multipart form data so browser writes cannot be CORS-simple", () => {
    expect(
      rejectCrossSiteMultipartWrite(
        request({ "content-type": "application/json" }),
      ),
    ).toEqual({
      error: "Content-Type must be multipart/form-data",
      status: 415,
    });
  });

  it("rejects non-loopback origins", () => {
    expect(
      rejectCrossSiteMultipartWrite(
        request({
          "content-type": "multipart/form-data; boundary=abc123",
          origin: "https://attacker.example",
        }),
      ),
    ).toEqual({ error: "Cross-origin write rejected", status: 403 });
  });

  it("rejects cross-site browser requests", () => {
    expect(
      rejectCrossSiteMultipartWrite(
        request({
          "content-type": "multipart/form-data; boundary=abc123",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toEqual({ error: "Cross-site write rejected", status: 403 });
  });
});
