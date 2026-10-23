# Changelog / 变更记录

All notable changes to this plugin are documented in this file, in English and Chinese.
本文件记录插件的所有重要变更，中英文并列。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] / 未发布

### Added / 新增

- **Expand linked notes as subtrees / 链接节点展开目标笔记子树**
  A node whose text is exactly a `[[wiki link]]` now carries an expand badge. Clicking it mounts the linked note — the whole note, a `#heading` section, or a `#^block` — under that node as a subtree that looks like ordinary map nodes.
  文本恰好是 `[[笔记]]` 的节点上会出现一枚展开徽标，点击后把目标笔记（整篇、`#小节` 或 `#^块`）作为子树挂到该节点下，形态与普通脑图节点一致。

- **Four link forms resolved / 四种链接写法均可解析**
  `[[note]]`, `[[note#Heading]]`, `[[note#^block]]` and `[[note#Heading|alias]]`. The alias affects display only; expansion always follows the target.
  `[[笔记]]`、`[[笔记#小节]]`、`[[笔记#^块]]`、`[[笔记#小节|别名]]`。别名只影响显示，展开始终按目标解析。

- **Heading matching by exact text / 按精确文本匹配标题**
  Headings match on trimmed text; a trailing `%%marker%%` is ignored, so plugin-written markers do not break the lookup. When several headings share a name the first one wins.
  标题按去掉首尾空白后的文本匹配；行尾的 `%%标记%%` 会被忽略，插件自己写入的标记不会影响定位。同名标题取第一个。

- **Depth setting / 展开深度设置**
  New setting **Link expand depth / 链接展开深度**, 1–5, default 2.
  新增设置项「链接展开深度」，可选 1–5，默认 2。

- **`…` node to dig deeper / 「…」节点继续下挖**
  When output is truncated, a `…` node sits at the end of the subtree; clicking it re-expands from the accumulated depth.
  内容被截断时，子树末尾会有一个「…」节点，点击后按累计深度继续展开。

- **Open target from the virtual root / 虚拟根打开目标**
  The virtual root carries an "open target" button that opens the linked note.
  虚拟根上有「打开目标」按钮，可直接打开被链接的笔记。

### Changed / 改动

- **The subtree is virtual and never written back / 子树是虚拟的，永不写回**
  `MindNode` gains optional `virtual` / `linkRef` / `moreNode` fields. `serializeMarkdown` and `normalizeKinds` skip virtual nodes, so saving is unaffected. A regression test pins this down: serializing with a virtual subtree produces **byte-identical** output to serializing without it.
  `MindNode` 新增可选字段 `virtual` / `linkRef` / `moreNode`；`serializeMarkdown` 与 `normalizeKinds` 按 `isVirtualNode` 收口跳过，保存不受影响。有一条不变式测试锁死这一点：带虚拟子树与不带时，序列化输出**逐字节一致**。

- **Read-only interaction / 交互只读**
  Edit, delete, drag, drag-in, paste, create, convert, colour, task, marker, box and summary are all guarded for virtual nodes; drag targets are filtered so real nodes cannot be dropped into a virtual subtree. Virtual nodes no longer show the floating node toolbar.
  编辑、删除、拖拽、拖入、粘贴、新建、换写法、颜色、任务、标记、外框、概要等入口对虚拟节点全部加守卫；拖拽落点做了过滤，真实节点无法落进虚拟子树。虚拟节点不再显示浮动工具栏。

- **Expansion state lives in memory only / 展开状态只在内存**
  Held by a view-layer controller and never persisted. The registry is capped at 50, anchors are indexed by `WeakMap`, and the parsed note is cached so repeated expansion does not re-parse.
  由 view 层控制器持有，不持久化。注册表上限 50，锚点用 `WeakMap` 索引，解析结果做缓存，重复展开不再重新解析。

- **Auto refresh / 自动刷新**
  When the target note changes or is deleted, the subtree refreshes (debounced 500 ms) or collapses. After the source note is re-parsed, expansions are re-mounted by their text chain and fold state is preserved.
  目标笔记改动或删除时，子树自动刷新（500 ms 去抖）或收起。源笔记重新解析后，按「根到锚点的文字链」重新挂载，折叠状态保留。

- **Cycle and depth protection / 循环与深度防护**
  An expansion is refused when any ancestor on the chain already expands the same note (compared by resolved path), when a note links to itself, or when nesting exceeds 5 levels.
  祖先链上任何一层已展开同一篇笔记（按解析后路径比对）、自链接、嵌套超过 5 层，都会拒绝。

- **Budget / 预算**
  A single expansion produces at most 200 nodes before truncation.
  单次展开最多产出 200 个节点即截断。

### Fixed / 修复

- A second click on the badge no longer starts a duplicate expansion; expanding is now idempotent per anchor, and collapsing removes **all** virtual roots under the anchor even if two were mounted concurrently.
  徽标第二次点击不再重复发起展开；展开按锚点幂等，收起时即使并发挂上了两棵虚拟子树也会全部清掉。

### Tests / 测试

- 6 new test files, 30 cases: serialization invariant, subpath resolution, depth and node budget, `…` accumulation, cycle / self-link / chain depth, and expand-collapse idempotence.
  新增 6 个测试文件、30 个用例：序列化不变式、子路径定位、深度与节点预算、「…」累计下挖、环 / 自链 / 链深、展开-收起幂等。
- Suite passes 101/101; `tsc --noEmit` reports no errors.
  全套 101/101 通过，`tsc --noEmit` 无错误。

### Docs / 文档

- English and Chinese READMEs describe the feature.
  `README.md` 与 `README.zh-CN.md` 补充功能说明。
