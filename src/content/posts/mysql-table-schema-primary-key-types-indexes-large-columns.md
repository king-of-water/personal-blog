---
title: MySQL 表结构怎样设计：主键、数据类型、索引与大字段
description: 以订单表评审为例，从查询路径和业务约束出发，系统说明 MySQL 主键、字段类型、NULL、字符集、索引与 JSON/TEXT 大字段的设计取舍。
category: 后端
subcategory: MySQL
articleClass: focused
seriesOrder: 80
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [MySQL, 表结构设计, 主键, 数据类型, 索引, JSON, 大字段]
---

表结构评审经常从字段类型开始：`id` 用 `BIGINT` 还是 `VARCHAR`，金额用分还是 `DECIMAL`，状态用 `TINYINT` 还是 `ENUM`。这些问题都要回答，但顺序反了。没有查询路径、唯一性和状态约束，单独讨论某一列用几字节，很容易得到一张“字段看起来很规范、业务操作却很昂贵”的表。

一张在线业务表要同时承担四件事：用约束拒绝不合法数据，用主键组织聚簇索引，用二级索引支撑查询，还要控制每行与每次写入的成本。字段定义会沿这些路径反复放大。一个很长的主键会复制进每棵二级索引；一个放在主表中的大 JSON 会影响缓存密度、复制与变更成本；一个错误的排序规则可能让唯一键把两个业务上不同的编号判成相同。

本文以一张订单表的设计过程贯穿全文，讨论怎样根据查询与数据生命周期，把业务事实变成可验证、可维护的表结构。联合索引的排序和最左匹配已在[《MySQL 联合索引为什么遵循最左匹配》](/posts/mysql-composite-index-leftmost-prefix-bplus-tree/)中展开；全局 ID 与分片键的职责则见[《分布式 ID：UUID、Snowflake 与 Leaf》](/posts/distributed-id-uuid-snowflake-leaf/)。本文只处理单张 InnoDB 表的结构决策，不再整理一遍 MySQL 类型手册。

## 一、先写查询与约束，再写 CREATE TABLE

假设业务需要保存电商订单。第一版需求通常只给出字段清单：订单号、用户、金额、状态、地址、扩展信息和时间。直接翻译成 DDL，可能得到下面的表：

```sql
CREATE TABLE orders_bad (
    id            VARCHAR(64)  NOT NULL,
    user_id       VARCHAR(64)  NOT NULL,
    order_no      VARCHAR(255) NOT NULL,
    amount        DOUBLE       NOT NULL,
    status        VARCHAR(64)  NOT NULL,
    address       TEXT,
    extra         JSON,
    create_time   VARCHAR(32)  NOT NULL,
    update_time   VARCHAR(32)  NOT NULL,
    PRIMARY KEY (id),
    KEY idx_user_id (user_id),
    KEY idx_status (status),
    KEY idx_create_time (create_time)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```

这张表能创建，也能写入数据，却没有说明任何业务边界：`order_no` 是否全局唯一，金额能否为负，状态有哪些合法值，时间按哪个时区解释，用户订单列表怎样排序，支付回调如何定位订单。单列索引很多，但它们未必对应真实 SQL。

评审前应先列出主要操作：

```text
1. 按 order_no 精确查询订单，支付回调也走这条路径
2. 按 user_id 查询最近订单，按 created_at DESC, id DESC 游标翻页
3. 扫描某些 status 下超时未处理的订单
4. 按主键推进状态，使用 version 做 CAS
5. 订单主记录高频读取，地址快照与扩展信息只在详情页使用
6. order_no、金额、币种和创建时间写入后不允许随意改语义
```

再列约束：订单号唯一；金额以确定精度存储且不能为负；状态只能沿状态机推进；时间必须可排序；任何订单都必须归属一个用户；扩展字段不能成为核心查询的唯一数据源。

查询决定索引的前导列和顺序，约束决定唯一键、`NOT NULL`、`CHECK` 与字段边界，数据生命周期决定哪些列留在热表。DDL 是这些结论的载体。

![从业务操作到 MySQL 表结构的评审顺序](/images/posts/mysql-schema-review-flow.svg)

## 二、主键同时是 InnoDB 的组织键

InnoDB 的主键有两层含义。逻辑上，它唯一标识一行；物理上，它通常就是聚簇索引，叶子记录保存完整行。若没有显式主键，InnoDB 会选择第一个全部为 `NOT NULL` 的唯一索引；再没有合适索引，才创建隐藏的 `GEN_CLUST_INDEX`。官方的[聚簇索引说明](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html)因此建议每张表显式定义主键。

### 短主键会同时缩小所有二级索引

InnoDB 的每条二级索引记录都会携带主键列，用它回到聚簇索引读取完整行。若主键是 `BIGINT`，这部分通常是 8 字节；若主键是 `VARCHAR(64)` 的长字符串，每棵二级索引都要重复保存相应值，还要按字符集与排序规则比较。

假设一张表有五个二级索引和一亿行。把主键增加的字节数简单乘以索引数量与行数，已经能看到数量级；实际空间还会包含记录头、页目录、页空闲和 B+ 树内部节点。主键变宽带来的成本不只存在于 `PRIMARY`。

![主键宽度怎样复制到每一棵 InnoDB 二级索引](/images/posts/mysql-primary-key-amplification.svg)

图中没有给出一个固定“节省百分比”，因为索引列、压缩、页填充率与数据分布都会改变结果。可以确定的是复制路径：每新增一棵二级索引，长主键就多出现一遍。

### 自增主键、全局 ID 和业务键怎样分工

订单表可以采用下面几种方式：

| 方案 | 聚簇主键 | 业务唯一键 | 适合场景 |
| --- | --- | --- | --- |
| 本地自增 | `id BIGINT AUTO_INCREMENT` | `UNIQUE(order_no)` | 单库或总能先路由到单表，行号无需跨片唯一 |
| 64 bit 全局 ID | Snowflake/Leaf `BIGINT` | 可与业务 ID 合并或另建 | 写库前要拿 ID、跨库合并或事件只携带一个 ID |
| 自然业务键 | `order_no` 等 | 主键本身 | 键短、稳定、永不修改，且大量查询直接使用它 |

自然键的主要风险是不稳定或太宽。手机号会换，用户名会改，多个业务字段组成的复合主键会复制到所有二级索引。订单号若长度可控、语义稳定，确实可以做主键；保留一个短整数行号并给订单号建唯一索引，通常让内部组织与对外标识的职责更清楚。

趋势递增的 `BIGINT` 也更容易把新记录写到聚簇索引右侧附近。随机 UUIDv4 文本主键会把插入分散到更广的叶子页，同时占用更多索引空间。需要 UUID 时，可以评估 UUIDv7、`BINARY(16)` 等更紧凑且更有局部性的表示，但仍要从实际写入模式与跨系统契约出发。

无论采用哪种方案，都不要让可修改字段充当主键。更新聚簇键相当于改变行在聚簇索引中的位置，也会牵连二级索引中的主键副本。

## 三、字段类型要匹配值域和运算

类型设计的首要问题是“它表达什么”，然后才是占几字节。把时间存成字符串、金额存成浮点数、布尔状态存成任意文本，会让数据库无法提供本来可以提供的校验、排序和计算语义。

### 整数按可证明的范围选择

MySQL 8.4 中，`TINYINT`、`SMALLINT`、`MEDIUMINT`、`INT` 和 `BIGINT` 分别占 1、2、3、4、8 字节。官方的[整数类型表](https://dev.mysql.com/doc/refman/8.4/en/integer-types.html)同时列出了有符号与无符号范围。

用户 ID、订单 ID 往往直接使用 `BIGINT`，因为其生命周期长且可能来自全局发号器。状态值只有少量枚举，可以使用 `TINYINT`，但应通过 `CHECK` 或应用状态机约束合法范围。库存数量、重试次数与分片号则根据上限选择，没必要统一成 `BIGINT`。

也不要为了节省几个字节把未来上限压得过紧。类型迁移会触发 DDL、应用兼容与回滚问题。合理做法是根据增长速度和保留年限估算，并留下可解释的余量，而不是所有列一律最小或一律最大。

`INT(11)` 中的 11 曾是显示宽度，不会让 `INT` 从 4 字节变成 11 字节，也不限制可存位数。MySQL 8 中整数显示宽度语法已经不值得继续作为表设计依据。

### 金额需要精确表示

`FLOAT` 与 `DOUBLE` 是近似数。二进制浮点无法精确表示许多十进制小数，直接做金额等值比较与累计会出现舍入问题。MySQL 的[精确值说明](https://dev.mysql.com/doc/refman/8.4/en/precision-math-numbers.html)把整数和 `DECIMAL` 归为精确值类型，把浮点归为近似值类型。

金额常见两种存法：

```sql
amount_minor BIGINT NOT NULL COMMENT '最小货币单位，例如分'
```

或者：

```sql
amount DECIMAL(19, 4) NOT NULL
```

以分为单位的整数适合精度固定、计算规则清晰的单一货币业务。`DECIMAL` 适合需要保留小数位、汇率、计价单位或多币种精度不同的场景。无论选哪种，都应同时保存 `currency`，并规定舍入发生在哪一层。单有一个 `amount=100`，无法判断它是 100 元、100 分还是另一种货币。

`DECIMAL(M,D)` 的 `M` 是总位数，`D` 是小数位数。它不是“精度越大越保险”的免费配置。范围、存储和接口序列化都要与业务金额上限一致。

### 时间类型要先确定语义

`TIMESTAMP` 会按照会话时区与 UTC 之间转换，`DATETIME` 保存字面日期时间，不受会话时区转换影响。MySQL 的[时区说明](https://dev.mysql.com/doc/refman/8.4/en/time-zone-support.html)明确区分了两者；`TIMESTAMP` 在 MySQL 8.4 的范围上限仍受 2038 年边界约束。

事件发生时刻通常可以统一按 UTC 写入 `TIMESTAMP` 或按团队规范使用 UTC `DATETIME`，读取后在应用层展示本地时区。预约“当地时间 2027-03-01 09:00”则还可能需要地点和时区规则，仅存 UTC 时刻会丢掉未来时区政策变化下的原始意图。

创建时间与更新时间应使用时间类型，并明确是否需要微秒：

```sql
created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                              ON UPDATE CURRENT_TIMESTAMP(3)
```

毫秒精度会增加存储与索引宽度。只有业务排序、去重或审计确实需要时才加入，不要默认所有时间都用 `(6)`。

## 四、字符串设计同时受字符集和排序规则影响

`VARCHAR(64)` 的 64 表示最多 64 个字符，不是固定预留 64 字节。`VARCHAR` 按实际内容保存，并附加 1 或 2 字节长度信息；最大可声明长度还受字符集和单行总大小限制。官方的[`CHAR` 与 `VARCHAR` 说明](https://dev.mysql.com/doc/refman/8.4/en/char.html)列出了具体存储规则。

### CHAR 不等于性能更好

`CHAR(N)` 适合长度真正固定的值，例如固定格式国家码、摘要或协议字段。它会按声明长度处理并涉及尾部空格语义。订单号虽然常常“看起来固定”，只要未来可能改变编码版本或增加前缀，`VARCHAR` 就更稳妥。

“定长字段查得更快”不能脱离存储引擎、行格式、索引与实际值长度成立。InnoDB 的 `DYNAMIC` 行格式会按自己的记录布局处理可变长和长字段。业务表设计时，更应关心值是否固定、比较语义是否正确，以及索引能否控制在合理宽度。

### utf8mb4 下要区分字符数和字节数

`utf8mb4` 的一个字符最多可占 4 字节。索引长度限制按字节计算，而 DDL 中字符串索引前缀通常按字符指定。MySQL 8.4 的[列索引说明](https://dev.mysql.com/doc/refman/8.4/en/column-indexes.html)指出，使用 `DYNAMIC` 或 `COMPRESSED` 行格式时，InnoDB 索引键前缀上限为 3072 字节。

因此 `(tenant_code VARCHAR(128), order_no VARCHAR(255))` 在 `utf8mb4` 下不能只把 128+255 当作索引长度。还要结合最大字节数、排序规则、主键扩展和其他索引列计算。

前缀索引可以缩小索引：

```sql
KEY idx_url_prefix (long_url(128))
```

但它只索引开头一段，无法单独保证完整字符串唯一，也可能因公共前缀太长而缺少区分度。设计前应统计不同前缀长度的选择性；若查询本质是完整等值查找，还可以保存稳定哈希并在命中后核对原值，不能只依赖哈希排除碰撞。

### Collation 决定比较与唯一性

字符集决定怎样编码字符，Collation 决定字符串怎样比较和排序。大小写是否敏感、重音是否敏感、尾部空格怎样处理，都会影响 `WHERE`、`ORDER BY` 和唯一索引。

用户昵称通常希望按语言规则比较；订单号、幂等键、哈希和区分大小写的外部标识更接近二进制身份。若业务规定 `AbC` 与 `abc` 是两个不同编号，却使用不区分大小写的 Collation 建唯一键，第二个值可能被当成重复。

表级默认值适合普通文本，身份字段可以显式选择二进制 Collation 或使用 `VARBINARY`。这项决定应该写入字段注释和接口契约，不能依赖开发者记住实例默认排序规则。

## 五、NULL、默认值与约束表达业务事实

`NULL` 表示未知或不适用，不等于空字符串、0 或某个“特殊日期”。把未支付时间保存为 `'1970-01-01'`，会让范围统计把它当成真实时间；把未知金额存成 0，会混淆“尚未计算”和“确实免费”。

另一方面，所有字段都允许 `NULL` 会让查询和唯一性更难理解。设计时逐列回答：该事实是否可能缺失，缺失的业务含义是什么，由谁补齐，补齐前哪些操作被允许。确定必有值的列直接声明 `NOT NULL`。

### 默认值不能掩盖调用方遗漏

状态默认 `PENDING` 可能合理，因为创建订单的初态固定；币种默认 `CNY` 则可能把漏传参数悄悄变成真实订单。默认值适合无歧义的系统行为，不适合替调用方猜业务值。

MySQL 的严格 SQL Mode 应在所有环境保持一致，避免测试环境把超长字符串截断为警告，生产环境却直接报错，或反过来。字段长度既是存储边界，也是输入契约的一部分。

### 唯一键和 CHECK 把错误挡在写入点

数据库唯一键可以承接订单号、请求幂等键等最终约束：

```sql
UNIQUE KEY uk_order_no (order_no),
UNIQUE KEY uk_user_request (user_id, request_id),
CONSTRAINT chk_amount_nonnegative CHECK (amount_minor >= 0),
CONSTRAINT chk_status CHECK (status IN (10, 20, 30, 40, 50))
```

应用预查“是否存在”无法替代唯一键，因为两个并发事务都可能在预查时看不到对方，随后同时插入。正确流程是让数据库完成原子冲突判断，应用处理重复键结果。

外键也不应按口号统一禁止或统一开启。同一数据库内、生命周期明确且写入规模可控时，外键能阻止孤儿数据；跨库分片、高并发级联或需要独立发布的服务边界中，外键可能无法使用。选择应用保证完整性时，要补上异步校验、修复任务和删除协议，而不是只移除约束。

## 六、索引是查询能力，也是写放大

每新增一棵二级索引，INSERT 都要增加一份索引记录，DELETE 要处理相应记录，更新被索引列也要修改索引。索引还占用 Buffer Pool 和磁盘，并在备份、恢复、复制回放与 DDL 中增加成本。

索引评审应从 SQL 形状开始：等值条件有哪些，范围条件在哪里，怎样排序，返回哪些列，一次期望命中多少行。不要把“以后可能会按它查”作为每个字段建单列索引的理由。

### 用真实查询合并索引

订单列表 SQL 是：

```sql
SELECT id, order_no, status, amount_minor, created_at
FROM orders
WHERE user_id = ?
  AND (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

对应索引可以是：

```sql
KEY idx_user_created (user_id, created_at DESC, id DESC)
```

`user_id` 先完成等值收缩，`created_at,id` 同时承担游标范围与稳定排序。单独建立 `idx_user_id(user_id)` 和 `idx_create_time(created_at)` 通常无法为这条查询提供同样的连续访问路径，而且前者很可能被联合索引的左前缀覆盖。

超时订单扫描可能是：

```sql
SELECT id
FROM orders
WHERE status = 10
  AND created_at < ?
ORDER BY created_at, id
LIMIT 500;
```

对应 `(status, created_at, id)`。`status` 单列区分度不高，但与时间范围组合后可以定位到一个待处理窗口。是否加覆盖列要看扫描频率与回表成本，不能把整个详情页字段塞进索引。

### 识别冗余与重复索引

若已经有 `KEY idx_user_created(user_id, created_at, id)`，普通 `KEY idx_user(user_id)` 很可能冗余。若 `order_no` 上已经有唯一索引，再建普通 `KEY idx_order_no(order_no)` 就是重复维护同一排序结构。

也不能只看 DDL 文本判断索引用途。先从慢查询、Performance Schema 和执行计划确认真实访问，再观察一段完整业务周期。删除索引前要考虑月末任务、补偿脚本与故障工具，并准备可回滚方案。

## 七、大字段决定热表能装下多少热点行

InnoDB 页面通常承载多行记录。行越宽，同一页面容纳的记录越少，扫描相同行数需要访问更多页面，Buffer Pool 能缓存的热点行也更少。`SELECT` 不返回某个大字段，并不保证它对聚簇索引的页面布局完全没有影响。

MySQL 有 65,535 字节的逻辑行大小限制，InnoDB 还有与页面和行格式有关的本地记录限制。`DYNAMIC` 行格式可以把较长的可变长字段内容放到溢出页，本地记录保留引用；具体是否离页取决于整行与字段值，不能把“TEXT 永远离页、VARCHAR 永远行内”当作规则。官方的[行大小限制](https://dev.mysql.com/doc/refman/8.4/en/column-count-limit.html)与[InnoDB Row Formats](https://dev.mysql.com/doc/refman/8.4/en/innodb-row-format.html)给出了这些边界。

### 垂直拆表按访问频率隔离大字段

订单地址快照、买家留言和渠道原始响应只在详情页或审计时读取，而订单主表要承接列表、状态推进与扫描。可以拆成：

```sql
CREATE TABLE order_detail (
    order_id          BIGINT NOT NULL,
    address_snapshot  JSON NOT NULL,
    buyer_note        TEXT,
    channel_payload   JSON,
    PRIMARY KEY (order_id)
) ENGINE = InnoDB;
```

主表保留高频过滤、排序、状态推进和展示摘要所需字段。拆表后，列表查询能在更紧凑的聚簇索引上运行；详情页多一次主键查询。这个取舍适合“绝大多数请求不需要大字段”的场景。若每次读取都必须同时拿详情，拆表只会增加一次访问和一致性处理。

拆表还要明确事务边界。订单创建时主表与详情表是否必须原子写入，详情缺失能否降级，删除与归档怎样同步。物理拆分不会自动解决这些问题。

### JSON 用来承接长尾属性，不替代稳定模型

MySQL `JSON` 类型会校验文档合法性，并使用内部二进制格式，适合不同渠道携带的少量长尾属性。高频查询、排序、关联和约束字段应保留为普通列：

```sql
-- 不要让支付渠道成为只能在 JSON 中提取的核心条件
channel VARCHAR(32) NOT NULL,
extra   JSON        NULL
```

JSON 列不能像普通标量列那样直接建立常规索引。MySQL 支持对提取出的标量建立生成列索引或函数索引，例如：

```sql
CREATE INDEX idx_extra_campaign
ON orders ((JSON_VALUE(extra, '$.campaignId' RETURNING UNSIGNED)));
```

官方的[JSON 搜索函数说明](https://dev.mysql.com/doc/refman/8.4/en/json-search-functions.html)给出了相同的函数索引形式。只要某个路径开始承担稳定查询、唯一性或关联，它通常已经从“长尾扩展”变成正式业务字段，应评估迁移成类型明确的列。这样可以得到更清楚的 `NOT NULL`、`CHECK`、外键和接口契约。

### 大对象也可能根本不该进 MySQL

图片、文件、超大请求响应与可重建日志通常更适合对象存储或专门日志系统，MySQL 只保存对象键、摘要、大小和状态。把几十 MB 二进制直接塞进业务表，会进入 Redo、Binlog、备份和复制链路，恢复与故障切换都要为这些字节付费。

是否外置要看事务要求。若数据库记录与对象上传无法原子提交，可以使用“上传临时对象、提交元数据、确认对象”的状态机，并定期清理孤儿文件。外置只改变存储位置，没有消除一致性问题。

## 八、把订单表收敛成可解释的设计

根据前面的查询与约束，一版更完整的主表可以写成：

```sql
CREATE TABLE orders (
    id            BIGINT NOT NULL AUTO_INCREMENT,
    order_no      VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id       BIGINT NOT NULL,
    request_id    VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status        TINYINT NOT NULL DEFAULT 10,
    amount_minor  BIGINT NOT NULL,
    currency      CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version       INT NOT NULL DEFAULT 0,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_no (order_no),
    UNIQUE KEY uk_user_request (user_id, request_id),
    KEY idx_user_created (user_id, created_at DESC, id DESC),
    KEY idx_status_created (status, created_at, id),
    CONSTRAINT chk_amount_nonnegative CHECK (amount_minor >= 0),
    CONSTRAINT chk_status CHECK (status IN (10, 20, 30, 40, 50))
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
  ROW_FORMAT = DYNAMIC;
```

这份 DDL 没有普适性。它背后的每项决定都能对应到前提：

- 本地自增 `id` 是短聚簇键，`order_no` 承担对外全局唯一；若系统写库前必须拿到全局 ID，可改用 Leaf 或 Snowflake `BIGINT`；
- 订单号、幂等请求号和币种使用 ASCII 二进制比较，避免大小写折叠与多字节空间；
- 金额使用最小货币单位，前提是业务已经固定精度；
- 两个联合索引分别服务用户列表与待处理扫描；
- 地址与渠道原始载荷进入详情表，主表保持紧凑；
- `CHECK` 只能限制合法状态集合，状态迁移顺序仍由带旧状态与版本号的条件更新保证。

状态推进可以写成：

```sql
UPDATE orders
SET status = ?, version = version + 1
WHERE id = ?
  AND status = ?
  AND version = ?;
```

这条 SQL 同时依赖短主键做点查、状态字段表达当前状态、版本号解决并发覆盖。表结构、索引和更新协议在这里汇合起来。

## 九、上线前怎样评审一张表

表结构评审可以沿下面的清单推进：

1. 写出 Top 查询、更新、扫描和删除路径，包含条件、排序、分页与预期行数；
2. 区分数据库主键、业务唯一 ID、幂等键和分片键，确认它们是否需要合并；
3. 为每列记录业务含义、值域、是否可空、默认值、是否可修改和保留时间；
4. 对金额、时间、状态、外部编号检查运算与比较语义；
5. 根据查询设计最少的一组联合索引，检查重复索引和低选择性单列索引；
6. 计算 `utf8mb4` 下的索引字节上限，确认 Collation 是否符合唯一性；
7. 识别大字段和低频字段，评估垂直拆分、对象存储与事务边界；
8. 用唯一键、`NOT NULL`、`CHECK` 或外键承接数据库能够原子保证的约束；
9. 估算未来数据量、增长速度、归档方式与字段扩容路径；
10. 用代表性数据执行 `EXPLAIN ANALYZE`，再观察实际写放大与缓存命中。

评审结论还要进入迁移方案。新表可以一次建对，存量大表上的字段和索引修改则可能引发元数据锁、重建、临时空间和复制延迟。下一篇会专门讨论数据量变大后的分区、归档、分库分表与 Online DDL，这里不把 DDL 能否执行等同于能否直接在线执行。

一张可维护的表不一定字段最少或字节最省。它应该让核心查询拥有连续访问路径，让错误数据在写入边界被拒绝，让高频行保持适当宽度，并为增长和迁移留下清楚的责任边界。只要每个字段和索引都能回答“服务哪条业务路径、付出什么写入与存储成本”，表结构就不再是一份命名清单。

## 参考资料

- [MySQL 8.4 Reference Manual: Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html)
- [MySQL 8.4 Reference Manual: Data Type Storage Requirements](https://dev.mysql.com/doc/refman/8.4/en/storage-requirements.html)
- [MySQL 8.4 Reference Manual: Integer Types](https://dev.mysql.com/doc/refman/8.4/en/integer-types.html)
- [MySQL 8.4 Reference Manual: Precision Math](https://dev.mysql.com/doc/refman/8.4/en/precision-math-numbers.html)
- [MySQL 8.4 Reference Manual: CHAR and VARCHAR](https://dev.mysql.com/doc/refman/8.4/en/char.html)
- [MySQL 8.4 Reference Manual: Column Indexes](https://dev.mysql.com/doc/refman/8.4/en/column-indexes.html)
- [MySQL 8.4 Reference Manual: Limits on Table Column Count and Row Size](https://dev.mysql.com/doc/refman/8.4/en/column-count-limit.html)
- [MySQL 8.4 Reference Manual: InnoDB Row Formats](https://dev.mysql.com/doc/refman/8.4/en/innodb-row-format.html)
- [MySQL 8.4 Reference Manual: The JSON Data Type](https://dev.mysql.com/doc/refman/8.4/en/json.html)
