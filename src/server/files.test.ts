import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { genericServerErrorResponse, GENERIC_SERVER_ERROR } from "./http-error.ts";
import { safeDownloadName } from "./files.ts";

describe("safeDownloadName", () => {
  it("strips CR/LF and other control characters", () => {
    const sneaky = "letter.pdf\r\nContent-Type: text/html";
    const cleaned = safeDownloadName(sneaky, "application/pdf");
    assert.equal(cleaned.includes("\r"), false);
    assert.equal(cleaned.includes("\n"), false);
    assert.equal(cleaned.includes("letter.pdf"), true);
    assert.equal(safeDownloadName("notes\npdf", "application/pdf").includes("\n"), false);
  });

  it("adds a pdf extension when missing", () => {
    assert.equal(safeDownloadName("school", "application/pdf"), "school.pdf");
  });
});

describe("genericServerErrorResponse", () => {
  it("returns a generic JSON 500 without exception text", async () => {
    const res = genericServerErrorResponse();
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, GENERIC_SERVER_ERROR);
    assert.equal(JSON.stringify(body).includes("TypeError"), false);
  });

  it("worker uses the generic error helper", () => {
    const src = readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
    assert.match(src, /genericServerErrorResponse/);
    assert.equal(src.includes("err.message"), false);
  });

  it("client ships optimistic check and undo-clear", () => {
    const src = readFileSync(new URL("../client/App.tsx", import.meta.url), "utf8");
    assert.match(src, /onPatchItems/);
    assert.match(src, /toast-undo/);
    assert.match(src, /checkedCleared/);
    assert.match(src, /nextChecked/);
  });
});
