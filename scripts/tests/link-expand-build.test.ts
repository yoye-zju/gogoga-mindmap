/** 克隆隔离性：虚拟副本与源文档互不影响；id 不冲突；表现字段不带入 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandToSubtree } from "../../src/link-expand";
import { parseMarkdown, serializeMarkdown } from "../../src/markdown";
import { createNode, walk, type MindNode } from "../../src/model";
import { makeHost } from "./link-expand-host";

const SRC = `# 源笔记

## 小节 %%green%%
- 有备注的条目
	备注内容

- 带宽度的条目 %%w=240%%

## 另一节
- 普通条目
`;

function fakeAnchor(): MindNode {
  return createNode({ parent: null, text: "[[源笔记]]", kind: "list" });
}

function countNodes(root: MindNode): number {
  let n = 0;
  walk(root, () => n++);
  return n;
}

test("改虚拟副本不影响源文档解析结果", async () => {
  const host = makeHost({ files: { "源笔记.md": SRC } });
  const srcDoc = parseMarkdown(SRC, { fallbackTitle: "" });
  const before = serializeMarkdown(srcDoc);
  const r = await expandToSubtree(host, fakeAnchor(), "源笔记#小节", 5);
  assert.ok(typeof r !== "string");
  walk(r.root, (n) => {
    n.text = "被改过的文字";
    n.folded = !n.folded;
    n.children = [];
  });
  assert.equal(serializeMarkdown(srcDoc), before);
});

test("虚拟副本不带源文件里的手动宽度，备注照常带过来", async () => {
  const host = makeHost({ files: { "源笔记.md": SRC } });
  const r = await expandToSubtree(host, fakeAnchor(), "源笔记", 5);
  assert.ok(typeof r !== "string");
  // 整篇展开：root.children 是两个二级标题
  assert.equal(r.root.children[0].text, "小节");
  const noteNode = r.root.children[0].children[0];
  assert.equal(noteNode.text, "有备注的条目");
  assert.equal(noteNode.note, "备注内容");
  const widthNode = r.root.children[0].children[1];
  assert.equal(widthNode.text, "带宽度的条目");
  assert.equal(widthNode.width, undefined);
});

test("虚拟节点 id 全新且不与源文档冲突；挂上真实树后 serialize 不变", async () => {
  const host = makeHost({ files: { "源笔记.md": SRC } });
  const doc = parseMarkdown(SRC, { fallbackTitle: "" });
  const srcIds = new Set<string>();
  walk(doc.root, (n) => srcIds.add(n.id));
  const r = await expandToSubtree(host, fakeAnchor(), "源笔记", 5);
  assert.ok(typeof r !== "string");
  const virtualIds = new Set<string>();
  walk(r.root, (n) => {
    assert.equal(srcIds.has(n.id), false);
    virtualIds.add(n.id);
  });
  assert.equal(virtualIds.size, countNodes(r.root));
  // 挂到真实树上再 serialize，与没挂时的基线逐字节一致
  const anchor = doc.root.children[0].children[0];
  anchor.children.push(r.root);
  r.root.parent = anchor;
  assert.equal(serializeMarkdown(doc), serializeMarkdown(parseMarkdown(SRC, { fallbackTitle: "" })));
});

test("两次展开同一目标得到互不相干的副本", async () => {
  const host = makeHost({ files: { "源笔记.md": SRC } });
  const r1 = await expandToSubtree(host, fakeAnchor(), "源笔记", 3);
  const r2 = await expandToSubtree(host, fakeAnchor(), "源笔记", 3);
  assert.ok(typeof r1 !== "string" && typeof r2 !== "string");
  walk(r1.root, (n) => (n.text = "改了"));
  assert.notEqual(r1.root.children[0].text, r2.root.children[0].text);
});
