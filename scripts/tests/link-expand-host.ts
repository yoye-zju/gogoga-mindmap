/** link-expand 纯逻辑测试的公共假宿主：内存文件 + 手工元数据 */
import type { LinkExpandHost } from "../../src/link-expand";
import type { MindNode } from "../../src/model";
import { walk } from "../../src/model";

export interface HostFixture {
  files: Record<string, string>;
  /** 路径 → 标题列表；不填则从文件内容现算 */
  headings?: Record<string, { text: string; level: number; line: number }[]>;
  /** 路径 → (块 id → 行号)；不填则从文件内容现算 */
  blocks?: Record<string, Record<string, number>>;
}

export function makeHost(fixture: HostFixture): LinkExpandHost {
  const { files, headings = {}, blocks = {} } = fixture;
  const byBase = new Map<string, string>();
  for (const p of Object.keys(files)) byBase.set(p.replace(/\.md$/i, "").split("/").pop()!.toLowerCase(), p);
  return {
    async read(path) {
      return path in files ? files[path] : null;
    },
    resolvePath(linktext) {
      const hit = byBase.get(linktext.trim().toLowerCase());
      return hit ?? null;
    },
    headings(path) {
      if (headings[path]) return headings[path];
      const out: { text: string; level: number; line: number }[] = [];
      let line = 0;
      for (const raw of (files[path] ?? "").split("\n")) {
        const m = /^(#{1,6})\s+(.*)$/.exec(raw);
        if (m) out.push({ text: m[2].trim(), level: m[1].length, line });
        line++;
      }
      return out;
    },
    blockLine(path, blockId) {
      if (blocks[path]?.[blockId] !== undefined) return blocks[path][blockId];
      const lines = (files[path] ?? "").split("\n");
      const idx = lines.findIndex((l) => l.trimEnd().endsWith(`^${blockId}`));
      return idx >= 0 ? idx : null;
    },
  };
}

/** 展开后把虚拟根挂到锚点下，返回锚点（便于继续断言） */
export function attach(anchor: MindNode, result: { root: MindNode } | string): MindNode {
  if (typeof result === "string") throw new Error(`期望子树，得到错误: ${result}`);
  result.root.parent = anchor;
  anchor.children.push(result.root);
  return anchor;
}

/** 收集虚拟根下的全部文字，断言用 */
export function texts(node: MindNode): string[] {
  const out: string[] = [];
  walk(node, (n) => {
    if (n !== node) out.push(n.text);
  });
  return out;
}
