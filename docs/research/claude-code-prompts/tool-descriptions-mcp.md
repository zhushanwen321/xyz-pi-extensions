# Claude Code MCP 工具描述

共 81 个工具中，约 50 个是 MCP 工具。按 MCP 服务器分组。

---

## chrome-devtools (28 个工具)

浏览器自动化调试工具集。

| 工具 | 描述 |
|------|------|
| click | 点击元素 |
| close_page | 关闭页面（最后一个不可关闭） |
| drag | 拖拽元素 |
| emulate | 模拟网络条件/CPU 节流/地理位置/UA/颜色方案/视口 |
| evaluate_script | 在页面中执行 JS 函数，返回 JSON |
| fill | 输入文本/选择下拉选项 |
| fill_form | 批量填充表单（优先于多次 fill/click） |
| get_console_message | 获取控制台消息 |
| get_network_request | 获取网络请求 |
| handle_dialog | 处理浏览器对话框 |
| hover | 悬停元素 |
| lighthouse_audit | Lighthouse 审计（无障碍/SEO/最佳实践） |
| list_console_messages | 列出控制台消息 |
| list_network_requests | 列出网络请求 |
| list_pages | 列出打开的页面 |
| navigate_page | 导航（URL/前进/后退/刷新） |
| new_page | 新建标签页 |
| performance_analyze_insight | 性能分析洞察 |
| performance_start_trace | 开始性能追踪（Core Web Vitals） |
| performance_stop_trace | 停止性能追踪 |
| press_key | 按键/快捷键 |
| resize_page | 调整页面尺寸 |
| select_page | 选择页面上下文 |
| take_heapsnapshot | 堆快照（内存分析） |
| take_screenshot | 截图 |
| take_snapshot | a11y 树快照（文本形式） |
| type_text | 键盘输入文本 |
| upload_file | 上传文件 |
| wait_for | 等待文本出现 |

---

## fetch (6 个工具)

网页内容抓取。

| 工具 | 描述 |
|------|------|
| fetch_html | 获取原始 HTML |
| fetch_json | 获取 JSON |
| fetch_markdown | 获取 Markdown 格式 |
| fetch_readable | Mozilla Readability 解析（去除导航/广告） |
| fetch_txt | 纯文本 |
| fetch_youtube_transcript | YouTube 字幕/转录 |

---

## memory (9 个工具)

知识图谱操作。

| 工具 | 描述 |
|------|------|
| add_observations | 添加观察到实体 |
| create_entities | 创建实体 |
| create_relations | 创建关系 |
| delete_entities | 删除实体 |
| delete_observations | 删除观察 |
| delete_relations | 删除关系 |
| open_nodes | 按名称打开节点 |
| read_graph | 读取整个知识图谱 |
| search_nodes | 按查询搜索节点 |

---

## MiniMax (2 个工具)

| 工具 | 描述 |
|------|------|
| understand_image | 图像分析（支持本地文件/URL，JPEG/PNG/WebP） |
| web_search | 网络搜索（类似 Google） |

**understand_image 重要规则**：
- 文件路径以 `@` 开头时必须去除 `@` 前缀
- 仅支持 JPEG, PNG, WebP 格式

---

## PostgreSQL (1 个工具)

| 工具 | 描述 |
|------|------|
| query | 只读 SQL 查询 |

---

## web-search (6 个工具)

| 工具 | 描述 |
|------|------|
| fetchCsdnArticle | 抓取 CSDN 文章全文 |
| fetchGithubReadme | 抓取 GitHub README |
| fetchJuejinArticle | 抓取掘金文章全文 |
| fetchLinuxDoArticle | 抓取 linux.do 文章全文 |
| fetchWebContent | 抓取公开 URL 内容（支持 Markdown 文件） |
| search | 网络搜索（Bing/Baidu，支持 request/playwright 模式） |

---

## 工具注入模式总结

```
请求注入层级：
├─ System Messages (3 条)
│  [0] billing header
│  [1] "You are Claude Code"
│  [2] 核心行为规则 (7405 字符)
│
├─ system-reminder (注入在 user message 中)
│  [msg-0] CLAUDE.md 全文 + rules/*.md
│  [msg-4] skill 列表 + ultracode 确认
│
├─ Tools (81 个)
│  核心: Agent, Skill, Workflow, Bash, Read, Write, Edit
│  任务: TaskCreate/Get/List/Update/Stop/Output
│  规划: EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree
│  调度: CronCreate/Delete/List, ScheduleWakeup
│  MCP: chrome-devtools(28), fetch(6), memory(9), MiniMax(2), PostgreSQL(1), web-search(6)
│
└─ 隐式注入
   StructuredOutput 工具（仅在 agent() 传入 schema 时出现）
```
