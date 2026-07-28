import assert from "node:assert/strict";
import test from "node:test";

import { detectContentType } from "../src/content-type.js";
import { renderMarkdown, validateAttachmentUrl } from "../src/markdown.js";
import { parseRemote, validateRepo } from "../src/repo.js";

test("renders safe GitHub attachment markdown", () => {
  const url = "https://github.com/user-attachments/assets/1234";
  assert.equal(renderMarkdown("a]b.png", url, "image/png"), `![a\\]b.png](${url})`);
  assert.equal(
    renderMarkdown("*report*_<draft>`~~a|b&copy;.pdf", url, "application/pdf"),
    "[\\*report\\*\\_\\<draft\\>\\`\\~\\~a\\|b\\&copy;.pdf](" + url + ")",
  );
  assert.equal(renderMarkdown("movie.mp4", url, "video/mp4"), url);
  assert.equal(
    renderMarkdown(
      "report.pdf",
      "https://github.com/user-attachments/files/1/report_(final).pdf",
      "application/pdf",
    ),
    "[report.pdf](https://github.com/user-attachments/files/1/report_%28final%29.pdf)",
  );
});

test("rejects non-GitHub and non-HTTPS result URLs", () => {
  assert.throws(() => validateAttachmentUrl("https://evil.example/x"), /untrusted/);
  assert.throws(
    () => validateAttachmentUrl("http://github.com/user-attachments/assets/1"),
    /untrusted/,
  );
});

test("parses supported GitHub remotes and rejects command-oriented names", () => {
  assert.deepEqual(parseRemote("git@github.com:octo/hello.git"), {
    owner: "octo",
    name: "hello",
  });
  assert.deepEqual(parseRemote("https://github.com/octo/hello"), {
    owner: "octo",
    name: "hello",
  });
  assert.throws(() => validateRepo("octo", "hello/../../settings"), /invalid/);
});

test("detects common MIME types beyond the GitHub override table", () => {
  assert.equal(detectContentType("report.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(detectContentType("module.wasm"), "application/wasm");
  assert.equal(detectContentType("feed.xml"), "application/xml");
});
