/** 深度截断与 hasMore：depth 决定保留几层，截断时补 hasMore 标记 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandToSubtree } from "../../src/link-expand";
import { createNode, type MindNode } from "../../src/model";
import { makeHost, texts } from "./link-expand-host";

const SRC = `# 笔记
- 一层甲
	- 二层甲一
		- 三层甲一乙
- 一层乙
`;

function fakeAnchor(): MindNode {
  return createNode({ parent: null, text: "[[笔记]]", kind: "list" });
}

test("depth=1 只保留目标顶层", async () => {
  const host = makeHost({ files: { "笔记.md": SRC } });
  const r = await expandToSubtree(host, fakeAnchor(), "笔记", 1);
  assert.ok(typeof r !== "string");
  assert.deepEqual(texts(r.root), ["一层甲", "一层乙"]);
  assert.equal(r.hasMore, true); // 之下还有内容被截掉
});

test("depth=2 保留两层", async () => {
  const host = makeHost({ files: { "笔记.md": SRC } });
  const r = await expandToSubtree(host, fakeAnchor(), "笔记", 2);
  assert.ok(typeof r !== "string");
  assert.deepEqual(texts(r.root), ["一层甲", "二层甲一", "一层乙"]);
  assert.equal(r.hasMore, true); // 三层被截
});

test("depth 足够深时无截断", async () => {
  const host = makeHost({ files: { "笔记.md": SRC } });
  const r = await expandToSubtree(host, fakeAnchor(), "笔记", 5);
  assert.ok(typeof r !== "string");
  assert.deepEqual(texts(r.root), ["一层甲", "二层甲一", "三层甲一乙", "一层乙"]);
  assert.equal(r.hasMore, false);
});

test("depth 非法值按 1 处理（防御，调用方也应 clamp）", async () => {
  const host = makeHost({ files: { "笔记.md": SRC } });
  const r0 = await expandToSubtree(host, fakeAnchor(), "笔记", 0);
  assert.ok(typeof r0 !== "string");
  assert.deepEqual(texts(r0.root), ["一层甲", "一层乙"]);
});

test("截断发生在预算耗尽时同样标记 hasMore", async () => {
  const items = Array.from({ length: 250 }, (_, i) => `- 条目 ${i}`).join("\n");
  const host = makeHost({ files: { "大.md": `# 大\n${items}` } });
  const r = await expandToSubtree(host, fakeAnchor(), "大", 5);
  assert.ok(typeof r !== "string");
  assert.equal(r.hasMore, true);
  assert.ok(r.root.children.length <= 250);
});
