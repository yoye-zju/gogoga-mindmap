/** 子路径定位：#标题 / #^块id / 整篇；命中同名取第一；不存在的子路径报错 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandToSubtree, MAX_EXPAND_NODES } from "../../src/link-expand";
import { createNode, isVirtualNode, type MindNode } from "../../src/model";
import { makeHost, texts } from "./link-expand-host";

const C = `# C 笔记

## 二级标题
- 条目一
	- 条目一的子条
- 条目二

## 二级标题
- 重复标题下的内容

## 带 %%red%% 标记的标题
- 标记不参与匹配
`;

/** 模拟画布上挂着 [[C]] 的真实链接节点 */
function fakeAnchor(text = "[[C]]"): MindNode {
  return createNode({ parent: null, text, kind: "list" });
}

test("#小节 按标题文本定位，命中同名取第一", async () => {
  const host = makeHost({ files: { "C.md": C } });
  const r1 = await expandToSubtree(host, fakeAnchor(), "C#二级标题", 2);
  assert.ok(typeof r1 !== "string");
  assert.deepEqual(texts(r1.root), ["条目一", "条目一的子条", "条目二"]);
});

test("标题里的 %% 标记：行中标记按原文匹配，行尾标记按剥掉标记的形式匹配", async () => {
  const host = makeHost({ files: { "C.md": C } });
  // 源文件 "## 带 %%red%% 标记的标题"：标记在行中，parseMarkdown 不会剥，node.text 原样
  const r = await expandToSubtree(host, fakeAnchor(), "C#带 %%red%% 标记的标题", 1);
  assert.ok(typeof r !== "string");
  assert.deepEqual(texts(r.root), ["标记不参与匹配"]);
  // 行尾标记（%%green%%）会被剥掉，查询里带着写也能命中
  const src2 = `# 另一篇\n\n## 目标节 %%green%%\n- 内容\n`;
  const host2 = makeHost({ files: { "另一篇.md": src2 } });
  const r2 = await expandToSubtree(host2, fakeAnchor("假"), "另一篇#目标节 %%green%%", 1);
  assert.ok(typeof r2 !== "string");
  assert.deepEqual(texts(r2.root), ["内容"]);
  // 查询里不带标记也能命中
  const r3 = await expandToSubtree(host2, fakeAnchor("假"), "另一篇#目标节", 1);
  assert.ok(typeof r3 !== "string");
});

test("#^块id 定位到列表块，取它的孩子", async () => {
  const src = `# 块笔记
- 目标块 ^blk1
	- 块的孩子甲
	- 块的孩子乙
- 别的条目
`;
  const host = makeHost({ files: { "B.md": src } });
  const r = await expandToSubtree(host, fakeAnchor(), "B#^blk1", 2);
  assert.ok(typeof r !== "string");
  assert.deepEqual(texts(r.root), ["块的孩子甲", "块的孩子乙"]);
  // 虚拟根文字取块自身文本
  assert.equal(r.root.text, "目标块");
});

test("无子路径时取整篇顶层，虚拟根文字为文件名", async () => {
  const host = makeHost({
    files: { "整篇.md": "# 标题不算\n- 顶层甲\n- 顶层乙\n\t- 乙的孩子" },
  });
  const r = await expandToSubtree(host, fakeAnchor(), "整篇", 2);
  assert.ok(typeof r !== "string");
  assert.equal(r.root.text, "整篇");
  assert.deepEqual(texts(r.root), ["顶层甲", "顶层乙", "乙的孩子"]);
});

test("目标不存在 / 子路径不存在 / 空目标 分别报对应错误", async () => {
  const host = makeHost({ files: { "C.md": "# 空标题\n" } });
  assert.equal(await expandToSubtree(host, fakeAnchor(), "不存在的笔记", 2), "targetNotFound");
  assert.equal(await expandToSubtree(host, fakeAnchor(), "C#没有这个小节", 2), "subpathNotFound");
  assert.equal(await expandToSubtree(host, fakeAnchor(), "C#空标题", 2), "emptyTarget");
  assert.equal(await expandToSubtree(host, fakeAnchor(), "C#^noblock", 2), "subpathNotFound");
});

test("单次展开节点数受 MAX_EXPAND_NODES 预算约束", async () => {
  const items = Array.from({ length: 300 }, (_, i) => `- 条目 ${i}`).join("\n");
  const host = makeHost({ files: { "大.md": `# 大笔记\n${items}` } });
  const r = await expandToSubtree(host, fakeAnchor(), "大", 1);
  assert.ok(typeof r !== "string");
  assert.equal(r.hasMore, true);
  assert.equal(r.root.children.length, MAX_EXPAND_NODES);
});

test("展开产物全部是虚拟节点且带 linkRef", async () => {
  const host = makeHost({ files: { "C.md": C } });
  const r = await expandToSubtree(host, fakeAnchor(), "C#二级标题", 3);
  assert.ok(typeof r !== "string");
  assert.equal(isVirtualNode(r.root), true);
  assert.deepEqual(r.root.linkRef, { target: "C#二级标题", subpath: "二级标题" });
});
