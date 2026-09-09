# Protocol Structure Viewer

Protocol Structure Viewer renders binary protocols, packets, and register layouts as responsive byte and bit diagrams in Obsidian. Define a layout with a concise `protocol` code block—no HTML, SVG, or YAML required.

## Features

- Display fixed-size byte layouts with configurable bytes per row.
- Describe single-byte bit fields and continuous multi-byte bit streams.
- Model mutually exclusive layouts with variants and nested cases.
- Inspect field details, highlight wrapped fields, and collapse long unused ranges.
- Detect invalid ranges, overlaps, and out-of-bounds fields with line-numbered errors.

## Installation

### Community plugins

After the plugin is accepted into the Obsidian Community directory:

1. Open **Settings → Community plugins** in Obsidian.
2. Select **Browse** and search for **Protocol Structure Viewer**.
3. Select **Install**, then select **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release.
2. Create `<Vault>/.obsidian/plugins/protocol-structure-viewer/`.
3. Copy the downloaded files into that directory.
4. Reload Obsidian, then enable **Protocol Structure Viewer** under **Settings → Community plugins**.

## Usage

Add a `protocol` code block to a Markdown note. Text enclosed in `<...>` is a placeholder that should be replaced with your own field names and descriptions.

````markdown
```protocol
@name <Protocol name>
@size 4
@row 16

0x00 | <Header field> | <Header description>
  bit 7..4 | <Bit field A> | <Bit field A description>
  bit 3..0 | <Bit field B> | <Bit field B description>
0x01..0x02 | <Payload field> | <Payload description>
0x03 | <Checksum field> | <Checksum description>
```
````

The plugin renders the code block in Reading view. Click a colored field to inspect its range, length, description, and byte or bit subfields.

## 中文文档

Protocol Structure Viewer 是一个用于展示二进制协议、数据包和寄存器布局的 Obsidian 插件。用户只需在 `protocol` 代码块中编写简洁文本，不需要编写 HTML、SVG 或 YAML。

## 功能

- 按固定字节数分行展示完整协议结构。
- 支持十进制和十六进制字节范围。
- 支持单字节 `bit 7..0` 位域与灵活的 **位序（Bit Order）方向配置**（`MSB-first` 高位在前 vs `LSB-first` 低位在前），满足网络协议与硬件寄存器不同场景。
- 支持多字节连续位流和跨字节字段。
- 支持 `byte 0` / `bytes 0..N` 相对字节子字段，无需生成多余的 bit 图。
- 字段说明与弹窗描述原生支持 **Markdown 富文本**与 Obsidian **`[[双链笔记]]`** 跳转。
- 提供 **Obsidian 全局设置页**，支持配置默认每行字节数、默认位序（MSB/LSB）、默认展开/折叠字段说明及位域指示条。
- 支持 `@variant` 模式变体：公共字段只写一次，互斥布局按条件切换。
- 支持在模式内用一层 `@case` 描述查询结果等次级布局；仅在需要时显示第三级路径项。
- 模式和 case 以标题右侧的面包屑下拉项切换，并支持“全部模式”纵向 lane 对比视图。
- 字段跨显示行时，悬浮和点击会同时高亮所有区段。
- 单个字段跨越超过 3 个显示行时，自动省略中间行，只保留首行、末行和一个可交互的省略标记。
- 支持用显式 `@compact` 属性把未使用的协议尾块合并成一行，只保留前几个和后几个字节。
- 点击字段会弹出结构化详情卡片。
- 字段弹窗中的单字节和多字节 bit 块可点击放大，长描述会自动换行显示。
- 纯文字详情自动适应内容宽度，bit 结构使用宽窗口和横向滚动。
- 下方完整“字段说明”默认折叠，支持全局设置或用 `@details open/closed` 单独控制。
- 自动检查越界、重叠和无效范围，并显示带行号的错误信息。

## 安装与启用

插件目录应位于：

```text
<Vault>/.obsidian/plugins/protocol-structure-viewer/
```

目录中至少需要以下文件：

```text
manifest.json
main.js
styles.css
```

然后在 Obsidian 的“设置 → 第三方插件”中启用 **Protocol Structure Viewer**。修改插件文件后，需要重新加载插件或重启 Obsidian；已经打开的笔记可能还需要重新打开，或者切换一次编辑视图和阅读视图。

## 快速开始

以下示例中，所有形如 `<协议名称>`、`<字段A>`、`<条件值A>` 的内容均为占位符，使用时请替换为自己的定义。

在 Markdown 笔记中加入：

````markdown
```protocol
@name <协议名称>
@size 4
@row 16

0x00 | <头字段> | <头字段说明>
  bit 7..4 | <位域A> | <位域A说明>
  bit 3..0 | <位域B> | <位域B说明>
0x01..0x02 | <数据字段> | <数据字段说明>
  bits 0..7 | <子字段A> | <子字段A说明>
  bits 8..15 | <子字段B> | <子字段B说明>
0x03 | <校验字段> | <校验范围及算法说明>
```
````

代码块语言也可以写成 `packet-structure`：

````markdown
```packet-structure
0 | <字段A>
1..3 | <字段B>
4 | <字段C>
```
````

## 基本格式

每条字段定义使用三个由 `|` 分隔的部分：

```text
字节范围 | 字段名称 | 字段说明
```

字段说明可以省略：

```text
0x00 | <字段A>
0x01..0x03 | <字段B> | <字段B说明>
```

字段说明原生支持 Markdown 格式（如 `**加粗**`、`行内代码`、无序列表、以及 Obsidian 的 `[[双链笔记]]` 跳转）。

## 全局指令

指令以 `@` 开头，写法为 `@指令 值`，不使用冒号。

| 指令 | 别名 | 是否必填 | 说明 |
|---|---|---:|---|
| `@name` | `@title` | 否 | 协议图标题，默认是“协议结构” |
| `@size` | 无 | 否 | 数据包总字节数；省略时根据最后一个字段自动推断 |
| `@row` | `@columns`、`@bytes-per-row` | 否 | 每行显示的字节数，默认 `16`（可在设置中修改全局默认值） |
| `@details` | 无 | 否 | 下方“字段说明”是否展开，可选 `open` 或 `closed`；省略时使用全局设置 |
| `@bit-order` | `@bitorder`、`@endian` | 否 | 位序方向：`msb-first`（高位在前）或 `lsb-first`（低位在前），默认 `msb-first` |

示例：

```text
@name <协议名称>
@size <总字节数>
@row <每行字节数>
@details open
@bit-order lsb-first
```

限制：

- `@size` 范围是 `1..4096`。
- `@row` 范围是 `1..32`。
- `@details` 可选值为 `open`（展开）或 `closed`（折叠）。
- `@bit-order` 可选值为 `msb-first`（高位在前，别名 `msb`、`big`）或 `lsb-first`（低位在前，别名 `lsb`、`little`）。
- 指令会结束当前字段的子字段定义，因此 `byte`、`bytes`、`bit` 或 `bits` 行应紧跟在所属字段下面。

## 字节范围

单字节字段：

```text
0 | <字段A>
0x1F | <字段B>
```

连续字节字段：

```text
1..13 | <字段A>
0x0E..0x1A | <字段B>
```

规则：

- 十进制和十六进制可以使用同一种范围语法。
- 范围两端必须使用有效的非负整数。
- 结束偏移不能小于开始偏移。
- 字段不能超过 `@size`。
- 不同字段不能重叠。
- 没有定义字段的字节会显示为“未定义”。
- 图上方逐字节序号显示为不带 `0x` 的大写十六进制，例如 `00`、`0A`、`1F`。
- 下方“字段说明”中的范围显示为 `0x01–0x0D`。

## 多字节的字节子字段

字段按完整字节划分时，使用相对于父字段起点的 `byte` 或 `bytes`，不必写成 8-bit 位域：

```text
0x04..0x08 | <父字段> | <父字段说明>
  bytes 0 | <子字段A> | <子字段A说明>
  bytes 1 | <子字段B> | <子字段B说明>
  bytes 2 | <子字段C> | <子字段C说明>
  bytes 3 | <子字段D> | <子字段D说明>
  bytes 4 | <子字段E> | <子字段E说明>
```

`byte 0` 与 `bytes 0` 等价；范围可写成 `bytes 0..2`。上例源码中的相对索引 `0..4` 分别映射到实际协议偏移 `0x04..0x08`。

规则：

- `N` 字节父字段的有效相对范围是 `0..N-1`。
- 字节子字段不能相互重叠，也不能与 `bit` / `bits` 子字段混用。
- 未声明的相对字节显示为“未定义”。
- 字段详情顶部像主协议图一样只显示实际十六进制序号，例如 `04 05 06 07 08`，不显示 `byte 0 ·` 前缀，也不显示 `bit 7..0` 标尺。
- 在字段弹窗中再次点击任意 byte 子字段，可像 bit 子字段一样放大显示名称和完整说明；再次点击或按 `Esc` 收起。

## 单字节位域

单字节字段下面使用 `bit`：

```text
0x00 | <单字节字段> | <单字节字段说明>
  bit 7..6 | <位域A> | <位域A说明>
  bit 5 | <位域B> | <位域B说明>
  bit 4 | <位域C> | <位域C说明>
  bit 3..0 | <位域D> | <位域D说明>
```

规则：

- 单字节位号范围是 `0..7`。
- 位域之间不能重叠。
- 未声明的 bit 会显示为“未定义”。
- 顶部序号格直接使用所属位域的颜色。

### 位序（Bit Order / Endianness）

插件支持配置位序方向，适配不同硬件、通信协议规范（如 CAN、网络报文、各类传感器寄存器）：

- **MSB-first（默认，高位在前）**：从左向右排列为 `bit 7 → bit 0`。
- **LSB-first（低位在前）**：从左向右排列为 `bit 0 → bit 7`。

**配置方式**：
1. **全局默认设置**：在 Obsidian“设置 → Protocol Structure Viewer”中配置“默认位序方向（Bit Order）”。
2. **协议指令**：在协议块顶部添加 `@bit-order lsb-first`（或 `@endian little`）。
3. **单字段覆盖**：在特定字段行尾添加 `@lsb` 或 `@msb` 修饰符：

```text
@bit-order msb-first

# 默认遵循全局 MSB-first (bit 7..0)
0x00 | 标准寄存器
  bit 7..4 | 类型
  bit 3..0 | 长度

# 覆盖为 LSB-first (bit 0..7)
0x01 | 硬件标志位 @lsb | 该字段按低位优先展示
  bit 0..1 | 使能通道
  bit 2    | 报警标志
  bit 3..7 | 保留
```

## 多字节连续位流

多字节字段下面使用 `bits`。这里的数字不是物理 bit 编号，而是相对于该字段起点的连续位流位置：

```text
0x01..0x03 | <多字节字段> | <多字节字段说明>
  bits 0..9 | <子字段A> | <子字段A说明>
  bits 10..17 | <子字段B> | <子字段B说明>
  bits 18..23 | <子字段C> | <子字段C说明>
```

相对位流位置的换算规则：

- **MSB-first 模式下**：
  ```text
  相对字节索引 = floor(position / 8)
  物理 bit     = 7 - (position % 8)
  ```
  （相对位置 0 = 首字节 bit 7，相对位置 7 = 首字节 bit 0）

- **LSB-first 模式下**：
  ```text
  相对字节索引 = floor(position / 8)
  物理 bit     = position % 8
  ```
  （相对位置 0 = 首字节 bit 0，相对位置 7 = 首字节 bit 7）

规则：

- `N` 字节字段的有效相对范围是 `0..(N × 8 - 1)`。
- 多字节范围必须按升序书写，例如 `bits 0..9`。
- 多字节子字段不能相互重叠。
- 多字节位图会显示真实字节序号、每字节物理 bit 标签，以及各子字段的彩色跨度。
- 支持单字段通过 `@lsb` / `@msb` 独立切换位流的 bit 映射方向。
- 内容超过可用宽度时使用字段说明内部的横向滚动条查看。

## 模式变体

同一协议根据模式字节使用不同布局时，公共字段写在 `@variant` 之外，每个互斥布局写在独立变体中：

```text
@name <协议名称>
@size 16
@row 16

# 所有模式共有
0x00 | <公共字段A> | <公共字段A说明>
0x01 | <模式标识字段> | <模式标识字段说明>

@variant <模式A>
@when byte[1] == <模式值A>
0x02 | <模式A字段> | <模式A字段说明>

@case <次级布局A>
@when <请求字段> == <条件值A>
0x03..0x05 | <次级布局A字段> | <次级布局A字段说明>
0x06..0x0F | <未使用字段> | <未使用字段说明>
@endcase

@case <次级布局B>
@when <请求字段> == <条件值B>
0x03..0x07 | <次级布局B字段> | <次级布局B字段说明>
0x08..0x0F | <未使用字段> | <未使用字段说明>
@endcase
@endvariant

@variant <模式B>
@when byte[1] == <模式值B>
0x02..0x0F | <模式B字段> | <模式B字段说明>
@endvariant
```

指令含义：

| 指令 | 说明 |
|---|---|
| `@variant 名称` | 开始一个互斥布局；名称显示为标题后的模式面包屑 |
| `@case 名称` | 在当前模式内开始一个次级布局；名称显示为下一级面包屑 |
| `@when 条件` | 给当前 `@case`（若存在）或当前 `@variant` 添加人类可读条件；插件不显示或执行表达式 |
| `@endcase` | 结束当前次级布局，不带参数 |
| `@endvariant` | 结束当前模式，不带参数 |

规则：

- `@variant` 之外的字段是所有模式共有的公共字段。
- 公共字段、当前模式字段和当前 case 字段合并后不能重叠。
- 同一布局内字段不能重叠；不同模式或同一模式的不同 case 可以复用相同字节范围。
- 模式名称必须唯一；同一模式内 case 名称必须唯一，每个 case 至少包含一个字段。
- `@variant` 不能嵌套；`@case` 只能位于模式内且不能嵌套，因此最多两级。
- 面包屑选中普通模式时显示“公共字段 + 当前模式字段”；选中含 case 的模式后，才显示下一级选择项并加入当前 case 字段。
- “全部模式”按主模式纵向分 lane；含 case 的模式折叠成一个“查询结果（N 种）”摘要字段，不展开所有 case。
- `@when` 仅用于让未安装插件的读者理解模式条件，不会显示在协议图中，也不会根据实时数据自动切换模式。
- 未安装插件时，代码块仍按公共字段、模式和 case 的分段顺序显示，保持可读。

## 多子字段占位符示例

下面使用占位符展示一个多字节字段包含多个连续子字段的写法：

```text
0x01..0x04 | <多子字段父字段> | <父字段说明>
  bits 0..7 | <子字段A> | <子字段A说明>
  bits 8..15 | <子字段B> | <子字段B说明>
  bits 16..23 | <子字段C> | <子字段C说明>
  bits 24..31 | <子字段D> | <子字段D说明>
```

## 注释和转义

空行会被忽略。以下两种整行注释都受支持：

```text
# 这是注释
// 这也是注释
```

说明文字中如果需要使用竖线，写成 `\|`：

```text
0x00 | <字段名称> | <状态A> \| <状态B>
```

当前不支持行尾注释；`#` 和 `//` 只有位于一行开头时才表示注释。

## 显示与交互

### 完整协议图

- 每行字节数由 `@row` 决定。
- 含模式变体时，协议标题右侧显示可下拉的模式面包屑，选项包含每个模式和“全部模式”。
- 所选模式含 case 时，路径末尾再显示一个可下拉的 case 面包屑；其他模式不占用这部分界面。
- 单模式视图合并公共字段、所选模式和所选 case；“全部模式”仍按主模式分 lane，case 只显示摘要。
- 每行不显示额外的起始地址栏，只保留上方逐字节序号。
- 跨行字段会拆成多个可视区段，但仍作为同一个字段管理。
- 字段跨越 1～3 行时完整显示；超过 3 行时，中间所有行会合并为一个“中间省略”标记，只保留该字段的首行和末行。
- 省略标记仍属于原字段，支持与首尾区段同步悬浮、高亮和点击，并可打开相同的字段详情。
- 字段行末的 `@compact` 是显式显示属性，只能用于结束于协议末尾的一个字段；插件不根据字段名称或说明文字推断。
- `@compact` 字段把整个尾块合并为一个正常高度的协议行，字节栏显示开头 3 字节、`…` 和末尾 3 字节；它仍保留完整范围、点击高亮和字段说明。
- 鼠标悬浮其中一段时，属于同一字段的所有区段同时高亮。

### 点击弹窗

- 点击任意彩色字段会打开自定义详情卡片，不使用浏览器原生 tooltip。
- 再次点击当前字段、点击其他位置或点击关闭按钮会关闭卡片。
- 页面滚动、协议图横向滚动和窗口尺寸变化只会重新定位卡片，不会关闭。
- 只有文字的字段按文字内容自动调整宽度，最大宽度为 `68rem`。
- 包含单字节或多字节 bit 结构的字段使用大尺寸弹窗。
- 弹窗中不重复显示字段的十六进制范围。
- 点击弹窗中的彩色 byte 或 bit 子字段，会打开该子字段的放大卡片；再次点击、使用卡片关闭按钮或按 `Esc` 可收起。
- 放大卡片按内容自适应宽度，最大宽度固定为 `48rem`；过长描述自动换行，超出可视高度时在卡片内部滚动。

### 字段说明

- 完整“字段说明”位于协议图下方，默认折叠。
- 手动展开后会显示十六进制范围、字段名称、长度、描述和 bit 结构。
- 多字节位图固定显示横向滚动条。

## 错误检查

语法或结构错误会在代码块位置显示红色错误卡片，并尽可能给出行号。常见错误包括：

- 没有定义任何字段。
- 字节范围格式错误。
- 字段范围重叠。
- 字段超过 `@size`。
- bit 位域超过所属字段范围。
- bit 位域相互重叠。
- bytes 子字段超出父字段、相互重叠，或与 bits 子字段混用。
- 多字节位流范围使用了降序。
- `bit` 或 `bits` 前没有所属字段。
- 字段或位域缺少名称。
- `@variant` 嵌套、未结束、重名或没有字段。
- `@case` 位于模式外、嵌套、未结束、重名或没有字段。
- `@when` 位于模式外，或在同一个模式/case 内重复定义。
- 公共字段、模式字段与 case 字段在同一布局中重叠。
- 同一布局包含多个 `@compact` 字段，或 `@compact` 字段没有结束于协议末尾。
- 使用了未知的 `@` 指令。

## 最简语法速查

```text
@name 标题
@size 总字节数
@row 每行字节数

单字节 | 名称 | 可选说明
开始..结束 | 名称 | 可选说明
开始..协议末尾 | 名称 | 可选说明 | @compact
  byte 0 | 相对字节子字段名称 | 可选说明
  bytes 0..N | 相对字节范围名称 | 可选说明
  bit 7..0 | 单字节位域名称 | 可选说明
  bits 0..N | 多字节相对位流名称 | 可选说明

@variant 模式名称
@when 人类可读的模式条件
开始..结束 | 模式字段 | 可选说明
@case 次级布局名称
@when 人类可读的次级条件
开始..结束 | 次级布局字段 | 可选说明
@endcase
@endvariant
```

## 许可证

本项目采用 [MIT License](LICENSE)。
