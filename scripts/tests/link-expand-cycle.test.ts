/** 环检测：A→B→A、自链接拒绝；合法链放行；嵌套深度有上限 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainDepth, expandToSubtree, MAX_CHAIN, wouldCycle } from "../../src/link-expand";
import { createNode, type MindNode } from "../../src/model";
import { makeHost, texts } from "./link-expand-host";

const A = `# A
- 指向 B 的条目
`;
const B = `# B
- 指向 A 的条目
`;
const D = `# D
- 普通内容
`;

/** 构造锚点 → 已展开的虚拟根 → 里面的真实链接节点，返回那个内层链接节点 */
function nestedAnchor(anchorText: string, linkRefTarget: string, innerText: string): MindNode {
  const anchor = createNode({ parent: null, text: anchorText, kind: "list" });
  const vroot = createNode({ parent: anchor, text: "虚拟根", kind: "list", virtual: true, linkRef: { target: linkRefTarget } });
  const inner = createNode({ parent: vroot, text: innerText, kind: "list" });
  anchor.children.push(vroot);
  vroot.children.push(inner);
  return inner;
}

test("自链接拒绝：目标就是脑图所在的笔记本身", async () => {
  const host = makeHost({ files: { "A.md": A, "B.md": B, "D.md": D } });
  const anchor = createNode({ parent: null, text: "[[A]]", kind: "list" });
  // 锚点自己不在链上（[[B]] 展开 B 是本职），自链接靠 sourceFile 比较
  assert.equal(wouldCycle(anchor, "A"), false);
  assert.equal(await expandToSubtree(host, anchor, "A", 2, "A.md"), "cycle");
  // 目标是别的笔记时照常放行
  const ok = await expandToSubtree(host, anchor, "B", 2, "A.md");
  assert.ok(typeof ok !== "string");
});

test("A→B→A 成环拒绝", async () => {
  const host = makeHost({ files: { "A.md": A, "B.md": B, "D.md": D } });
  // 锚点是 [[A]] 的虚拟展开里出现的 [[B]]：再展开 B 里的 [[A]] 就回到 A
  const inner = nestedAnchor("[[A]]", "A", "[[B]]");
  assert.equal(wouldCycle(inner, "B"), false);
  assert.equal(wouldCycle(inner, "A"), true);
  assert.equal(await expandToSubtree(host, inner, "A", 2), "cycle");
});

test("合法链 A→B→D 放行", async () => {
  const host = makeHost({ files: { "A.md": A, "B.md": B, "D.md": D } });
  const inner = nestedAnchor("[[A]]", "A", "[[B]]");
  const r = await expandToSubtree(host, inner, "D", 2);
  assert.ok(typeof r !== "string");
  assert.deepEqual(texts(r.root), ["普通内容"]);
});

test("虚拟根祖先的 linkRef 也参与环判定", () => {
  const inner = nestedAnchor("[[X]]", "目标笔记", "[[别的]]");
  assert.equal(wouldCycle(inner, "别的"), false);
  assert.equal(wouldCycle(inner, "目标笔记"), true);
  assert.equal(wouldCycle(inner, "X"), true);
});

test("链深超过 MAX_CHAIN 拒绝（chainTooDeep）", async () => {
  const host = makeHost({ files: { "D.md": D, "E.md": "# E\n- 内容\n" } });
  // 叠满 MAX_CHAIN 层虚拟根；最内层是 [[E]]，展开 E 不构成环，只被链深拦下
  let node = createNode({ parent: null, text: "[[D]]", kind: "list" });
  for (let i = 0; i < MAX_CHAIN; i++) {
    const vroot = createNode({ parent: node, text: `虚拟根${i}`, kind: "list", virtual: true, linkRef: { target: `第${i}层` } });
    node.children.push(vroot);
    node = createNode({ parent: vroot, text: `内层${i}`, kind: "list" });
    vroot.children.push(node);
  }
  node.text = "[[E]]";
  assert.equal(chainDepth(node), MAX_CHAIN);
  assert.equal(await expandToSubtree(host, node, "E", 2), "chainTooDeep");
});
