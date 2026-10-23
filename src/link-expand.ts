/**
 * 链接节点展开子树：把 [[笔记]] / [[笔记#小节]] / [[笔记#^块]] 的目标解析成
 * 一棵挂在链接节点下面的只读虚拟子树。
 *
 * 铁律：虚拟节点只活在画布上，绝不写回 Markdown（serializeMarkdown 已按
 * isVirtualNode 收口，见 markdown.ts 与 link-expand-serialize 测试）。
 *
 * 本模块是纯逻辑：不 import obsidian，宿主能力通过 LinkExpandHost 注入，
 * 测试用内存假实现；view.ts 里再接到 app.vault / app.metadataCache 上。
 */

import { wikilinkOf } from "./inline";
import { parseMarkdown } from "./markdown";
import { createNode, isVirtualNode, walk, type MindDoc, type MindNode } from "./model";

/** 单次展开最多生成的虚拟节点数，超出强制 hasMore，防止一篇巨笔记撑爆画布 */
export const MAX_EXPAND_NODES = 200;
/** 虚拟子树最多嵌套多少层（A 展开 B、B 展开 C…），防失控 */
export const MAX_CHAIN = 5;

/** 宿主提供的最小能力集；路径一律是 vault 内带扩展名的完整路径 */
export interface LinkExpandHost {
  /** 缓存读全文；文件不存在返回 null */
  read(path: string): Promise<string | null>;
  /** 链接文本（不含 # 部分）→ vault 路径；解析不到返回 null */
  resolvePath(linktext: string): string | null;
  /** 文件的标题列表（metadataCache） */
  headings(path: string): { text: string; level: number; line: number }[];
  /** 块 id → 起始行号；找不到返回 null */
  blockLine(path: string, blockId: string): number | null;
  /**
   * 可选：把读到的全文解析成文档树。宿主可以在这里做「同一篇只解析一次」的缓存，
   * 省掉重复展开同一目标时的解析开销；不提供就直接 parseMarkdown。
   */
  parse?(path: string, src: string): MindDoc;
}

export type ExpandError = "cycle" | "chainTooDeep" | "targetNotFound" | "subpathNotFound" | "emptyTarget";

/** [[笔记#小节]] / [[笔记#^块id]] 拆开；# 后面不识别的子路径原样放 subpath */
export function parseLinktext(target: string): { file: string; subpath?: string; blockId?: string } {
  const i = target.indexOf("#");
  if (i < 0) return { file: target };
  const file = target.slice(0, i);
  const subpath = target.slice(i + 1);
  if (subpath.startsWith("^")) return { file, subpath, blockId: subpath.slice(1) };
  return { file, subpath };
}

/** 节点是否可展开：文本恰好是一个 wiki 链接（虚拟节点本身不算） */
export function getExpandableRef(node: MindNode): { target: string; alias?: string } | null {
  if (isVirtualNode(node)) return null;
  return wikilinkOf(node.text);
}

/** 锚点下现存的虚拟子树根。正常只有一个，并发/异常时可能残留多个，收起要按这个全清 */
export function virtualRootsOf(anchor: MindNode): MindNode[] {
  return anchor.children.filter((c) => isVirtualNode(c));
}

/**
 * 幂等摘除锚点下的所有虚拟子树根，返回摘掉的数量。
 * 收起一律走这里：不依赖注册表是否还记得这次展开，也就不会出现「点一下只收掉一半」。
 */
export function detachVirtualRoots(anchor: MindNode): number {
  const kept = anchor.children.filter((c) => !isVirtualNode(c));
  const removed = anchor.children.length - kept.length;
  if (removed) anchor.children = kept;
  return removed;
}

// ---------- 环检测 ----------

/**
 * 沿祖先链收集已涉及的目标：真实链接祖先取其文本目标，虚拟祖先取其 linkRef。
 * 锚点自己的文本目标不算——[[B]] 节点展开 B 正是它的本职；「自链接」（脑图所在
 * 笔记本身是展开目标）由 sourceFile 与解析后的路径比较来拦。
 */
function chainTargets(anchor: MindNode): string[] {
  const out: string[] = [];
  let cur = anchor.parent;
  while (cur) {
    const ref = getExpandableRef(cur);
    if (ref) out.push(ref.target);
    if (cur.linkRef) out.push(cur.linkRef.target);
    cur = cur.parent;
  }
  return out;
}

/** 目标已在展开链上（A→B→A）则拒绝展开；sourceFile 是脑图所在笔记的 vault 路径 */
export function wouldCycle(anchor: MindNode, linktext: string): boolean {
  const want = normalizeForCompare(linktext);
  return chainTargets(anchor).some((t) => normalizeForCompare(t) === want);
}

/** 链上已经叠了多少个虚拟根（不含本次要展开的） */
export function chainDepth(anchor: MindNode): number {
  let n = 0;
  let cur = anchor.parent;
  while (cur) {
    if (isVirtualNode(cur)) n++;
    cur = cur.parent;
  }
  return n;
}

/** 环比较用的小写化；目标里 # 后面大小写敏感，文件部分 Obsidian 不敏感，这里整体放宽 */
function normalizeForCompare(target: string): string {
  return target.trim().toLowerCase();
}

// ---------- 目标解析 ----------

/** 在目标文档里按标题文本找第一个匹配的标题节点；查询带行尾 %%标记%% 时按剥掉标记的形式比对 */
function findHeadingByText(root: MindNode, text: string): MindNode | null {
  const trimmed = text.trim();
  const stripped = trimmed.replace(/[ \t]*%%[^%]*%%[ \t]*$/, "").trim();
  let found: MindNode | null = null;
  walk(root, (n) => {
    if (found || n.kind !== "heading") return;
    const t = n.text.trim();
    if (t === trimmed || (stripped && t === stripped)) found = n;
  });
  return found;
}

/** 在目标文档里按块 id 找列表项节点（parseMarkdown 把 ^id 存在 blockId 上） */
function findBlockNode(root: MindNode, blockId: string): MindNode | null {
  let found: MindNode | null = null;
  walk(root, (n) => {
    if (!found && n.blockId === blockId) found = n;
  });
  return found;
}

export interface VirtualSubtree {
  /** 虚拟根（parent 未挂），children 是截断后的目标层级 */
  root: MindNode;
  /** 因深度/预算被截断，末尾应补「展开更多」 */
  hasMore: boolean;
}

interface Budget {
  count: number;
  limit: number;
  clipped: boolean;
}

/** 深拷贝为虚拟节点：新 id、置 virtual、清掉不该带过来的表现字段 */
export function deepCloneVirtual(node: MindNode, parent: MindNode | null, budget: Budget, depth: number): MindNode | null {
  if (depth < 0) return null;
  if (budget.count >= budget.limit) {
    budget.clipped = true;
    return null;
  }
  budget.count++;
  const copy = createNode({
    parent,
    text: node.text,
    note: node.note,
    tail: node.tail,
    color: node.color,
    folded: node.folded,
    kind: node.kind,
    level: node.level,
    bullet: node.bullet,
    blockId: node.blockId,
    virtual: true,
    // 外框/概要/手宽是源文件里的排版意图，虚拟子树里没有意义
  });
  for (const c of node.children) {
    const child = deepCloneVirtual(c, copy, budget, depth - 1);
    if (child) copy.children.push(child);
  }
  // 子节点被预算/深度截掉：整棵也算 clipped
  if (copy.children.length < node.children.length) budget.clipped = true;
  return copy;
}

/** 「展开更多」占位节点 */
export function makeMoreNode(parent: MindNode | null): MindNode {
  return createNode({ parent, text: "…", kind: "list", virtual: true, moreNode: true });
}

/**
 * 把链接目标解析成虚拟子树。
 * @param linktext 完整链接文本（可含 #小节 / #^块id）
 * @param depth 保留的层级深度（≥1），更深的层截掉
 * @param sourceFile 脑图所在笔记的 vault 路径；目标就是这篇笔记时按自链接拒绝
 */
export async function expandToSubtree(host: LinkExpandHost, anchor: MindNode, linktext: string, depth: number, sourceFile?: string): Promise<VirtualSubtree | ExpandError> {
  // 防御：调用方（设置面板）已 clamp，这里再兜一次底
  const keep = Math.max(1, Math.floor(depth));

  const { file, subpath, blockId } = parseLinktext(linktext);
  const path = host.resolvePath(file);
  if (!path) return "targetNotFound";

  // 自链接：目标就是脑图所在的笔记本身
  if (sourceFile && path === sourceFile) return "cycle";
  // 环检测：目标与祖先链上任何一层展开是同一篇笔记
  for (const t of chainTargets(anchor)) {
    const { file: f } = parseLinktext(t);
    if (f && host.resolvePath(f) === path) return "cycle";
  }
  if (chainDepth(anchor) >= MAX_CHAIN) return "chainTooDeep";

  const src = await host.read(path);
  if (src === null) return "targetNotFound";
  const doc = host.parse ? host.parse(path, src) : parseMarkdown(src, { fallbackTitle: "" });

  // 选中要展示的源节点：无子路径取整篇的顶层；#小节取该标题的孩子；#^块取该块的孩子
  let sourceNodes: MindNode[];
  let rootText: string;
  if (!subpath) {
    sourceNodes = doc.root.children;
    rootText = path.split("/").pop()?.replace(/\.md$/i, "") ?? file;
  } else if (blockId !== undefined) {
    const block = findBlockNode(doc.root, blockId);
    if (!block) return "subpathNotFound";
    sourceNodes = block.children;
    rootText = block.text;
  } else {
    const heading = findHeadingByText(doc.root, subpath);
    if (!heading) return "subpathNotFound";
    sourceNodes = heading.children;
    rootText = heading.text;
  }
  if (sourceNodes.length === 0) return "emptyTarget";

  const budget: Budget = { count: 0, limit: MAX_EXPAND_NODES, clipped: false };
  const root = createNode({
    parent: null,
    text: rootText,
    kind: "list",
    virtual: true,
    linkRef: { target: linktext, subpath },
  });
  for (const s of sourceNodes) {
    const clone = deepCloneVirtual(s, root, budget, keep - 1);
    if (clone) root.children.push(clone);
    if (budget.count >= budget.limit) {
      budget.clipped = true;
      break;
    }
  }
  return { root, hasMore: budget.clipped };
}
