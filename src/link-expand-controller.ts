/**
 * 链接展开的视图层控制器：持有展开状态（纯内存，不持久化），把画布的徽标/
 * 展开更多/打开目标事件接到 expandToSubtree 的纯逻辑上，并监听目标笔记的
 * 变化做刷新、在源文件重解析后按 text 链重新挂载。
 *
 * 状态设计：
 *   expansions[] —— 注册表（上限 50），每项记 textPath（根到锚点的文字链）
 *   anchors      —— WeakMap<锚点节点, Expansion>，徽标查询 O(1)，重解析后重建
 */

import { debounce, Notice, TFile } from "obsidian";
import type { CanvasHost, MindMapCanvas } from "./canvas";
import { t, type Key } from "./i18n";
import {
  detachVirtualRoots,
  expandToSubtree,
  getExpandableRef,
  makeMoreNode,
  parseLinktext,
  virtualRootsOf,
  type ExpandError,
  type LinkExpandHost,
} from "./link-expand";
import { parseMarkdown } from "./markdown";
import { isVirtualNode, walk, type MindDoc, type MindNode } from "./model";
import type MindMapPlugin from "./main";
import type { MindMapView } from "./view";

/** 注册表上限：一个视图里最多同时挂着多少个展开 */
const MAX_EXPANSIONS = 50;

interface Expansion {
  /** 根 → 锚点 的文字链（含根与锚点）；源文件重解析后据此重新匹配 */
  textPath: string[];
  /** 完整链接文本（可含 #小节） */
  linktext: string;
  /** 当前已展开深度（「展开更多」累加） */
  depth: number;
  virtualRoot: MindNode;
  hasMore: boolean;
}

export class LinkExpandController {
  private canvas: MindMapCanvas | null = null;
  private expansions: Expansion[] = [];
  private anchors = new WeakMap<MindNode, Expansion>();
  /** 正在展开中的锚点：挡掉「同一下点两遍」导致的重复挂载 */
  private pending = new Set<MindNode>();
  /**
   * 状态版本号：收起、重挂载都会自增。异步展开回来时若版本变了，结果直接丢弃，
   * 免得收起来之后又被一个迟到的 await 顶回去。
   */
  private epoch = 0;
  /** 目标笔记的解析缓存：同一篇只解析一次（按全文比对，文件改了自动重解析） */
  private docCache = new Map<string, { src: string; doc: MindDoc }>();
  private busy = false;
  /** 重挂载期间又来了新的树：排队再来一轮 */
  private reapplyQueued = false;
  private disposers: (() => void)[] = [];

  constructor(private view: MindMapView, private plugin: MindMapPlugin) {}

  /** 视图创建画布后调用；顺带挂上目标笔记变化的监听 */
  bind(canvas: MindMapCanvas): void {
    this.canvas = canvas;
    const refresh = debounce((path: string) => this.refreshForTarget(path), 500, true);
    const meta = this.plugin.app.metadataCache;
    this.view.registerEvent(meta.on("changed", (file) => refresh(file.path)));
    this.view.registerEvent(meta.on("deleted", (file) => this.dropForTarget(file.path)));
  }

  destroy(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.canvas = null;
    this.expansions = [];
    this.anchors = new WeakMap();
    this.pending.clear();
    this.docCache.clear();
  }

  /** 提供给 MindMapCanvas 的 CanvasOptions.host 的那几个方法 */
  hostMethods(): Pick<CanvasHost, "linkBadgeState" | "toggleLink" | "expandMore" | "openVirtualTarget"> {
    return {
      linkBadgeState: (node) => this.badgeState(node),
      toggleLink: (node) => this.toggleLink(node),
      expandMore: (moreNode) => void this.expandMore(moreNode),
      openVirtualTarget: (virtualRoot) => this.openTarget(virtualRoot),
    };
  }

  // ---------- 画布回调 ----------

  private depth(): number {
    const raw = this.plugin.settings.linkExpandDepth;
    return Math.max(1, Math.min(5, Math.floor(Number(raw) || 2)));
  }

  private enabled(): boolean {
    return this.depth() >= 1;
  }

  private badgeState(node: MindNode): "none" | "collapsed" | "expanded" {
    if (!this.enabled() || !getExpandableRef(node)) return "none";
    if (this.isExpanded(node)) return "expanded";
    return "collapsed";
  }

  /** 是否已经挂着虚拟子树（以画布上的树为准，注册表只是旁证） */
  private isExpanded(node: MindNode): boolean {
    return virtualRootsOf(node).length > 0 || this.anchors.has(node);
  }

  /** 节点是否还在当前画布树上：树被重解析后，旧节点上的异步结果一律作废 */
  private isLive(node: MindNode): boolean {
    const root = this.canvas?.getDoc()?.root;
    if (!root) return false;
    let found = false;
    walk(root, (n) => {
      if (n === node) found = true;
    });
    return found;
  }

  /** 徽标点击：一次调用完成展开/收起，按当前状态判断，重复点不会叠加 */
  private toggleLink(node: MindNode): void {
    if (this.isExpanded(node)) this.collapseLink(node);
    else void this.expandLink(node);
  }

  private noticeError(e: ExpandError): void {
    const key: Record<ExpandError, Key> = {
      cycle: "notice.linkExpandCycle",
      chainTooDeep: "notice.linkExpandTooDeep",
      targetNotFound: "notice.linkExpandNoTarget",
      subpathNotFound: "notice.linkExpandNoSubpath",
      emptyTarget: "notice.linkExpandEmpty",
    };
    new Notice(t(key[e]));
  }

  private async expandLink(node: MindNode): Promise<void> {
    const ref = getExpandableRef(node);
    if (!ref || this.isExpanded(node) || this.pending.has(node)) return;
    if (this.expansions.length >= MAX_EXPANSIONS) {
      // 丢掉最老的一个展开，保证注册表不涨
      const oldest = this.expansions.shift();
      if (oldest) this.detach(oldest);
    }
    const depth = this.depth();
    const epoch = this.epoch;
    this.pending.add(node);
    try {
      const result = await expandToSubtree(this.host, node, ref.target, depth, this.sourceFile());
      // 等待期间被收起（epoch 变了）或者树被重解析了（锚点已不在树上）：这份结果作废
      if (epoch !== this.epoch || !this.isLive(node)) return;
      if (this.isExpanded(node)) return; // 别人已经挂上了，不重复挂
      if (typeof result === "string") return this.noticeError(result);
      if (result.hasMore) result.root.children.push(makeMoreNode(result.root));
      result.root.parent = node;
      node.children.push(result.root);
      const entry: Expansion = { textPath: this.textPathOf(node), linktext: ref.target, depth, virtualRoot: result.root, hasMore: result.hasMore };
      this.expansions.push(entry);
      this.anchors.set(node, entry);
      this.canvas?.render();
    } catch (err) {
      // 别把异常吞成「点了没反应」：提示一句，并把细节留给控制台
      console.error("[gogoga-mindmap] 链接展开失败", err);
      new Notice(t("notice.linkExpandFailed"));
    } finally {
      this.pending.delete(node);
    }
  }

  private collapseLink(node: MindNode): void {
    // 先作废所有进行中的展开，再清干净：这样迟到的 await 不会把子树又顶回来
    this.epoch += 1;
    this.pending.delete(node);
    detachVirtualRoots(node);
    const path = this.textPathOf(node).join("\u0001");
    // 注册表里所有以这个锚点为准的条目一起清掉（同一锚点理论上只有一条，清了也不会漏）
    this.expansions = this.expansions.filter((e) => e.virtualRoot.parent !== node && e.textPath.join("\u0001") !== path);
    this.anchors.delete(node);
    this.canvas?.render();
  }

  /** 点「展开更多」：按当前深度 + 设置深度重解析，原位替换虚拟根 */
  private async expandMore(moreNode: MindNode): Promise<void> {
    const root = moreNode.parent;
    if (!root?.linkRef) return;
    let anchor: MindNode | null = root.parent;
    while (anchor && isVirtualNode(anchor)) anchor = anchor.parent;
    if (!anchor || this.pending.has(anchor)) return;
    const entry = this.anchors.get(anchor);
    const nextDepth = (entry?.depth ?? this.depth()) + this.depth();
    const epoch = this.epoch;
    this.pending.add(anchor);
    try {
      const result = await expandToSubtree(this.host, anchor, root.linkRef.target, nextDepth, this.sourceFile());
      if (epoch !== this.epoch || !this.isLive(anchor)) return; // 期间被收起/重解析：这份结果作废
      if (typeof result === "string") return this.noticeError(result);
      if (entry) {
        this.replaceSubtree(entry, result.root);
        entry.depth = nextDepth;
        entry.hasMore = result.hasMore;
      } else {
        // 没有注册表项（理论少见）：直接原位替换，保持显示一致
        this.swapVirtualRoot(root, result.root, result.hasMore);
      }
      this.canvas?.render();
    } catch (err) {
      console.error("[gogoga-mindmap] 展开更多失败", err);
      new Notice(t("notice.linkExpandFailed"));
    } finally {
      this.pending.delete(anchor);
    }
  }

  private openTarget(virtualRoot: MindNode): void {
    const target = virtualRoot.linkRef?.target;
    if (!target) return;
    const { file } = parseLinktext(target);
    void this.plugin.app.workspace.openLinkText(file || target, this.sourceFile());
  }

  // ---------- 挂载 / 摘除 / 替换 ----------

  private detach(entry: Expansion): void {
    const anchor = entry.virtualRoot.parent;
    if (anchor) detachVirtualRoots(anchor);
    this.anchors.delete(anchor as MindNode);
    this.expansions = this.expansions.filter((e) => e !== entry);
  }

  /** 原位替换虚拟根：保留旧子树的折叠状态（按文字链映射） */
  private replaceSubtree(entry: Expansion, fresh: MindNode): void {
    const anchor = entry.virtualRoot.parent;
    const folds = collectFolds(entry.virtualRoot);
    if (anchor) {
      const idx = anchor.children.indexOf(entry.virtualRoot);
      if (idx >= 0) anchor.children[idx] = fresh;
      else anchor.children.push(fresh);
      fresh.parent = anchor;
      this.anchors.set(anchor, entry);
    }
    applyFolds(fresh, folds);
    if (entry.hasMore) fresh.children.push(makeMoreNode(fresh));
    entry.virtualRoot = fresh;
  }

  /** 没有注册表项时的兜底替换 */
  private swapVirtualRoot(old: MindNode, fresh: MindNode, hasMore: boolean): void {
    const anchor = old.parent;
    const folds = collectFolds(old);
    if (anchor) {
      const idx = anchor.children.indexOf(old);
      if (idx >= 0) anchor.children[idx] = fresh;
      else anchor.children.push(fresh);
      fresh.parent = anchor;
    }
    applyFolds(fresh, folds);
    if (hasMore) fresh.children.push(makeMoreNode(fresh));
  }

  // ---------- 目标笔记变化 / 源文件重解析 ----------

  /** 目标笔记改了：刷新所有指向它的展开；目标没了就收起 */
  private async refreshForTarget(path: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const epoch = this.epoch;
    try {
      for (const entry of [...this.expansions]) {
        const anchor = entry.virtualRoot.parent;
        if (!anchor) continue;
        const { file } = parseLinktext(entry.linktext);
        const resolved = file ? this.plugin.app.metadataCache.getFirstLinkpathDest(file, this.sourceFile()) : null;
        if (!resolved) continue;
        if (resolved.path !== path) continue;
        const result = await expandToSubtree(this.host, anchor, entry.linktext, entry.depth, this.sourceFile());
        if (epoch !== this.epoch || !this.isLive(anchor)) return; // 刷新途中被收起/重解析：别再往回写
        if (typeof result === "string") {
          // 目标删了/清空了：收起，不打扰
          if (result === "targetNotFound" || result === "emptyTarget") this.detach(entry);
          continue;
        }
        this.replaceSubtree(entry, result.root);
        entry.hasMore = result.hasMore;
      }
      this.canvas?.render();
    } finally {
      this.busy = false;
    }
  }

  /** 目标笔记被删：收起指向它的展开 */
  private dropForTarget(path: string): void {
    for (const entry of [...this.expansions]) {
      const { file } = parseLinktext(entry.linktext);
      const resolved = file ? this.plugin.app.metadataCache.getFirstLinkpathDest(file, this.sourceFile()) : null;
      if (!resolved || resolved.path === path) this.detach(entry);
    }
    this.canvas?.render();
  }

  /** 源文件重解析（setViewData / undo / 外部变更）后重建所有展开 */
  async reapply(): Promise<void> {
    if (this.busy) {
      // 正在重挂：记一笔，等这轮结束再来一次，别让新的树丢掉展开
      this.reapplyQueued = true;
      return;
    }
    if (!this.canvas) return;
    const root = this.canvas.getDoc()?.root;
    if (!root) return;
    this.busy = true;
    try {
      const survivors: { entry: Expansion; anchor: MindNode }[] = [];
      this.anchors = new WeakMap();
      for (const entry of this.expansions) {
        const anchor = this.findByTextPath(root, entry.textPath);
        if (!anchor || !getExpandableRef(anchor)) continue; // 链接没了：静默清理
        survivors.push({ entry, anchor });
      }
      if (!survivors.length) {
        this.expansions = [];
        return;
      }
      const kept: { entry: Expansion; anchor: MindNode }[] = [];
      for (const { entry, anchor } of survivors) {
        const result = await expandToSubtree(this.host, anchor, entry.linktext, entry.depth, this.sourceFile());
        if (!this.isLive(anchor)) return; // 期间又换了一棵树：本轮放弃，交给排队的下一轮
        if (typeof result === "string") continue; // 重建失败（目标没了等）：这项放弃
        if (result.hasMore) result.root.children.push(makeMoreNode(result.root));
        result.root.parent = anchor;
        detachVirtualRoots(anchor); // 防御：新树理应是干净的
        anchor.children.push(result.root);
        // 旧子树的折叠状态按文字链映射过去
        applyFolds(result.root, collectFolds(entry.virtualRoot));
        entry.virtualRoot = result.root;
        entry.hasMore = result.hasMore;
        this.anchors.set(anchor, entry);
        kept.push({ entry, anchor });
      }
      this.expansions = kept.map((s) => s.entry);
      this.canvas.render();
    } finally {
      this.busy = false;
      if (this.reapplyQueued) {
        this.reapplyQueued = false;
        void this.reapply();
      }
    }
  }

  // ---------- 工具 ----------

  private get host(): LinkExpandHost {
    const app = this.plugin.app;
    return {
      read: async (path) => {
        const f = app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? app.vault.cachedRead(f) : null;
      },
      resolvePath: (linktext) => app.metadataCache.getFirstLinkpathDest(linktext, this.sourceFile())?.path ?? null,
      headings: (path) => {
        const f = app.vault.getAbstractFileByPath(path);
        const cache = f instanceof TFile ? app.metadataCache.getFileCache(f) : null;
        return cache?.headings?.map((h) => ({ text: h.heading, level: h.level, line: h.position.start.line })) ?? [];
      },
      blockLine: (path, blockId) => {
        const f = app.vault.getAbstractFileByPath(path);
        const cache = f instanceof TFile ? app.metadataCache.getFileCache(f) : null;
        return cache?.blocks?.[blockId]?.position.start.line ?? null;
      },
      parse: (path, src) => this.parseCached(path, src),
    };
  }

  /** 同一篇笔记只解析一次：全文一致就复用，改了就重新解析（缓存上限 20 篇） */
  private parseCached(path: string, src: string): MindDoc {
    const hit = this.docCache.get(path);
    if (hit && hit.src === src) return hit.doc;
    const doc = parseMarkdown(src, { fallbackTitle: "" });
    this.docCache.set(path, { src, doc });
    if (this.docCache.size > 20) {
      // 淘汰最早进来的那一篇（Map 保持插入顺序）；当前这篇不淘汰
      for (const key of this.docCache.keys()) {
        if (key !== path) this.docCache.delete(key);
        break;
      }
    }
    return doc;
  }

  private sourceFile(): string {
    return this.view.file?.path ?? "";
  }

  /** 根 → node 的文字链（含根与 node） */
  private textPathOf(node: MindNode): string[] {
    const chain: string[] = [];
    for (let cur: MindNode | null = node; cur; cur = cur.parent) chain.unshift(cur.text);
    return chain;
  }

  /** 在新树上按文字链找锚点；找不到返回 null（重命名/删除就放弃） */
  private findByTextPath(root: MindNode, path: string[]): MindNode | null {
    if (root.text !== path[0]) return null;
    let cur = root;
    for (let i = 1; i < path.length; i++) {
      const next = cur.children.find((c) => !isVirtualNode(c) && c.text === path[i]);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }
}

/** 虚拟子树内的折叠状态：子树内文字链 → folded */
function collectFolds(root: MindNode): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const visit = (n: MindNode, key: string) => {
    const k = key + "\u0001" + n.text;
    out.set(k, n.folded);
    for (const c of n.children) visit(c, k);
  };
  for (const c of root.children) visit(c, "");
  return out;
}

function applyFolds(root: MindNode, folds: Map<string, boolean>): void {
  if (!folds.size) return;
  const visit = (n: MindNode, key: string) => {
    const k = key + "\u0001" + n.text;
    const f = folds.get(k);
    if (f !== undefined) n.folded = f;
    for (const c of n.children) visit(c, k);
  };
  for (const c of root.children) visit(c, "");
}
