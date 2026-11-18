# dsh-memory-list · 记忆树（DSH 插件版）

> **想先了解这个项目本身是什么？** 看 [docs/项目介绍.md](docs/项目介绍.md)：树的分层、五条轨、四个算法、数据格式、设计取舍都写在那儿。

把原来的「记忆树 · 记忆空间」单文件服务（`node app.mjs` 起 8080）改造成 DeepSeek Harness 的原生插件：
跑在 DSH 自己的 webServer 里，走 `/dsh-memory-list/` 前缀，侧栏有「识海」入口，数据落在独立目录。

## 装

### 0. 从 GitHub 拿下来

```bash
git clone https://github.com/luogrant/dsh-memory-list.git E:/dsh-plugins/dsh-memory-list
```

插件目录放到任意位置均可，然后在 profile 里登记（A / B 两选一）。

### A. 官方插件安装

```bash
dsh plugin --profile <profile> add file:E:/dsh-plugins/dsh-memory-list
```

再确认 profile 的 `dsh.profile.bundles` 末尾出现 `dsh-memory-list`，然后**重启 DeepSeek Harness**
（HMR 不接管新增 bundle，改 package.json 只会触发 restart required）。

### B. 手改 profile

在 `$DSH_HOME/profiles/<profile>/package.json`：

```json
{
  "dependencies": { "dsh-memory-list": "file:E:/dsh-plugins/dsh-memory-list" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-memory-list" ] } }
}
```

并在 `profiles/<profile>/node_modules/dsh-memory-list` 放一个指向插件目录的 junction/symlink。

## 数据目录

默认 `$DSH_HOME/memory-list/`，可用环境变量覆盖：

| 变量 | 作用 | 默认 |
|---|---|---|
| `SHIRAM_HOME` | 数据根（优先） | `$DSH_HOME/memory-list` |
| `SHIRAM_DATA` | `识海.json` 的完整路径 | `$SHIRAM_HOME/识海.json` |
| `SHIRAM_BACKUP` | 备份目录 | `$SHIRAM_HOME/backup` |
| `SHIRAM_PORT` | 独立模式端口 | 8080 |
| `SHIRAM_SESSIONS` | DSH 会话目录（汲取用） | `$DSH_HOME/sessions` |
| `SHIRAM_LLM_CONFIG` | 模型配置 | 包内 `llm.json` |

首次启动时若 `识海.json` 不存在，会从包内骨架 `data/识海.json` 自动初始化，不再 `process.exit(1)`。
每天首次写入会在 `backup/` 留一份快照（保留 30 份）。

想让数据完全离开 C 盘 / DSH_HOME：把 `$DSH_HOME/memory-list` 做成指向目标目录的 Windows junction 即可，插件代码零改动。

## 路由

页面：`/dsh-memory-list/`（五个页签：列表 / 星图 / 人设 / 五轨 / 汲取）、`/dsh-memory-list/orbit`（3D 星轨子页）。

API（全部相对路径，插件模式与独立模式通用）：

- `/dsh-memory-list/api/rev`、`api/status`、`api/tree`、`api/tracks`、`api/star3d`
- `api/tracks/<track>`（`memory|user|project|key|daily`）及其 `/replace` `/remove` `/archive` `/add`
- `api/memory` `/add|update|delete`、`api/tree` `/rename|add-node|delete-node`
- `api/personas` `/add|update|delete`、`api/consolidate`、`api/lifecycle`
- `api/intake` `/scan|tidy|promote|promote-q5`、`api/auto`（GET/POST）、`api/sessions`

## 独立模式

仍然是原来的单文件服务，可以直接起：

```bash
node app.mjs          # http://127.0.0.1:8080/
```

## 目录

```
app.mjs            数据层 + 五轨 + 树 + 人设 + 汲取 + 整理 + 晋升 + HTTP 路由（导出 处理）
index.js           DSH 半边：inject ['webServer']，/dsh-memory-list 前缀 + requestRejection 鉴权
client.js          DSH 前端半边：侧栏「识海」入口 + iframe 主区
cordis.patch.yml   bundle 挂载声明
index.html         列表 / 星图 / 人设 / 五轨 / 汲取
pages/星轨.html    3D 星轨
data/识海.json     空骨架（首次启动的模板）
llm.json           模型配置
```

## 来源

上游为 gitee.com/vampirexx/memory-list 的单文件服务，本仓库是插件化改造版（路由前缀、懒加载数据层、可注入的数据根、DSH webServer 挂载、侧栏入口）。

## License

MIT
