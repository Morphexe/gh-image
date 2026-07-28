import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/args.js";

test("parses upload flags in any position", () => {
  assert.deepEqual(parseArgs(["shot.png", "--repo", "octo/hello", "--token=t"]), {
    command: "upload",
    repo: { owner: "octo", name: "hello" },
    token: "t",
    paths: ["shot.png"],
  });
});

test("dispatches subcommands unless protected by --", () => {
  assert.equal(parseArgs(["extract-token"]).command, "extract-token");
  assert.deepEqual(parseArgs(["--", "extract-token"]), {
    command: "upload",
    paths: ["extract-token"],
  });
});

test("rejects duplicate and malformed flags", () => {
  assert.throws(() => parseArgs(["--repo", "a/b", "--repo=c/d", "x"]), /more than once/);
  assert.throws(() => parseArgs(["--repo", "not-a-repo", "x"]), /owner\/repo/);
  assert.throws(() => parseArgs(["--token="]), /cannot be empty/);
  assert.throws(() => parseArgs(["--wat"]), /unknown flag/);
});
