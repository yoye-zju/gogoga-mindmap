/** 展开/收起的幂等性：锚点下的虚拟子树必须能一次全清，重复收起不出错 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detachVirtualRoots, expandToSubtree, virtualRootsOf } from "../../src/link-expand";
import { createNode, type MindNode } from "../../src/model";
import { attach, makeHost, texts } from "./link-expand-host";

const SRC = `# 笔记
- 甲
- 乙
`;

function anchorWithRealChild(): MindNode {
  const anchor = createNode({ parent: null, text: "[[笔记]]", kind: "list" });
  anchor.children.push(createNode({ parent: anchor, text: "真实子节点", kind: "list" }));
  return anchor;
}

test("收起一次摘掉虚拟子树，保留真实子节点", async () => {
  const host = makeHost({ files: { "笔记.md": SRC } });
  const anchor = anchorWithRealChild();
  attach(anchor, await expandToSubtree(host, anchor, "笔记", 2));
  assert.equal(anchor.children.length, 2);
  assert.equal(virtualRootsOf(anchor).length, 1);

  assert.equal(detachVirtualRoots(anchor), 1);
  assert.deepEqual(
    anchor.children.map((c) => c.text),
    ["真实子节点"],
  );
  assert.equal(virtualRootsOf(anchor).length, 0);
});

test("重复收起是幂等的（第二次返回 0，不抛错）", async () => {
  const host = makeHost({ files: { "笔记.md": SRC } });
  const anchor = anchorWithRealChild();
  attach(anchor, await expandToSubtree(host, anchor, "笔记", 2));
  detachVirtualRoots(anchor);
  assert.equal(detachVirtualRoots(anchor), 0);
  assert.deepEqual(
    anchor.children.map((c) => c.text),
    ["真实子节点"],
  );
});

test("并发展开留下两棵虚拟子树时，一次收起全部清掉", async () => {
  // 回归：以前收藏起只摘注册表里记得的那一棵，另一棵留着，徽标还显示「已展开」，
  // 用户表现为「第二次点徽标不收起来」
  const host = makeHost({ files: { "笔记.md": SRC } });
  const anchor = anchorWithRealChild();
  const first = await expandToSubtree(host, anchor, "笔记", 2);
  const second = await expandToSubtree(host, anchor, "笔记", 2);
  attach(anchor, first);
  attach(anchor, second);
  assert.equal(anchor.children.length, 3);
  assert.equal(virtualRootsOf(anchor).length, 2);
  assert.deepEqual(texts(anchor).filter((t) => t === "甲").length, 2);

  assert.equal(detachVirtualRoots(anchor), 2);
  assert.deepEqual(
    anchor.children.map((c) => c.text),
    ["真实子节点"],
  );
});

test("没有虚拟子树时收起不改变 children 引用", () => {
  const anchor = anchorWithRealChild();
  const before = anchor.children;
  assert.equal(detachVirtualRoots(anchor), 0);
  assert.equal(anchor.children, before);
});
