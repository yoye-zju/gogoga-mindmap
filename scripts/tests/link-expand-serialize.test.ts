/**
 * 链接展开虚拟子树的核心不变式：带虚拟子树的模型，serialize 输出与不带时逐字节一致。
 * 虚拟节点只活在画布上，任何标记（fold/color/box/summary/width/side）都不得泄露进 Markdown。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, serializeMarkdown, normalizeKinds } from "../../src/markdown";
import { createNode, findByPath, isVirtualNode, pathOf, walk, type MindNode } from "../../src/model";

const canonical = `# 项目总览

## 进行中 %%green%%
- 后端重构
	- 拆分单体模块
- 前端改版

## 已归档
- 旧版官网 %%fold%%
`;

function makeVirtualRoot(children: MindNode[]): MindNode {
  const root = createNode({
    parent: null,
    text: "[[被展开的笔记]]",
    kind: "heading",
    level: 2,
    virtual: true,
    linkRef: { target: "被展开的笔记" },
    color: "red",
    folded: true,
    width: 320,
    side: "left",
    note: "虚拟根的备注，不该出现在文件里",
  });
  root.children = children;
  for (const c of children) c.parent = root;
  return root;
}

function makeMoreNode(): MindNode {
  return createNode({
    parent: null,
    text: "…",
    kind: "list",
    moreNode: true,
    virtual: true,
    color: "blue",
  });
}

test("虚拟子树挂在标题与列表节点下，serialize 输出逐字节一致", () => {
  const clean = parseMarkdown(canonical);
  const dirty = parseMarkdown(canonical);

  // 标题节点下挂虚拟根（带一串会泄露的标记与子节点）
  const heading = findByPath(dirty.root, "0")!;
  const vr = makeVirtualRoot([
    createNode({ parent: null, text: "二级标题", kind: "heading", level: 3, color: "purple", folded: true }),
    createNode({ parent: null, text: "- 列表项 %%red%%", kind: "list", note: "备注也会泄露" }),
    makeMoreNode(),
  ]);
  for (const c of vr.children) c.parent = vr;
  heading.children.push(vr);
  vr.parent = heading;

  // 列表节点下挂「展开更多」
  const list = findByPath(dirty.root, "0/1")!;
  list.children.push(makeMoreNode());

  // 根节点下也挂一个
  dirty.root.children.push(makeVirtualRoot([]));

  assert.equal(serializeMarkdown(dirty), serializeMarkdown(clean));
  assert.equal(serializeMarkdown(dirty), canonical);
});

test("虚拟子树挂在根下（rootFromHeading 之外的合成根情形）也一致", () => {
  const src = `- 甲
- 乙
	- 乙一
`;
  const clean = parseMarkdown(src);
  const dirty = parseMarkdown(src);
  dirty.root.children.push(makeVirtualRoot([createNode({ parent: null, text: "x", kind: "list" })]));
  assert.equal(serializeMarkdown(dirty), serializeMarkdown(clean));
  assert.equal(serializeMarkdown(dirty), src);
});

test("normalizeKinds 不深入虚拟子树改写 kind/level", () => {
  const doc = parseMarkdown(canonical);
  const heading = findByPath(doc.root, "0")!;
  const vr = makeVirtualRoot([createNode({ parent: null, text: "二级标题", kind: "heading", level: 2 })]);
  heading.children.push(vr);
  normalizeKinds(doc);
  // 挂在列表容器里的 heading 本会被降级成 list，虚拟子树必须原样保留
  assert.equal(vr.kind, "heading");
  assert.equal(vr.children[0].kind, "heading");
  assert.equal(vr.children[0].level, 2);
});

test("挂上虚拟子树后，真实节点的 index 路径不变", () => {
  const doc = parseMarkdown(canonical);
  const list = findByPath(doc.root, "0/1")!;
  const before = pathOf(list);
  list.children.push(makeVirtualRoot([makeMoreNode()]));
  assert.equal(pathOf(list), before);
  // 虚拟子树都追加在末尾，前面真实子节点的路径不受影响
  assert.equal(pathOf(findByPath(doc.root, "0/0")!), "0/0");
});

test("isVirtualNode 谓词与字段语义", () => {
  const doc = parseMarkdown(canonical);
  const list = findByPath(doc.root, "0/1")!;
  const vr = makeVirtualRoot([makeMoreNode()]);
  vr.parent = list;
  list.children.push(vr);
  assert.equal(isVirtualNode(vr), true);
  assert.equal(isVirtualNode(list), false);
  assert.equal(isVirtualNode(vr.children[0]), true); // moreNode 同时标 virtual，同样不序列化
  // 全树遍历：虚拟标记只出现在挂上去的那棵子树里
  let virtualCount = 0;
  let moreCount = 0;
  walk(doc.root, (n: MindNode) => {
    if (n.virtual) virtualCount++;
    if (n.moreNode) moreCount++;
  });
  assert.equal(virtualCount, 2);
  assert.equal(moreCount, 1);
});
