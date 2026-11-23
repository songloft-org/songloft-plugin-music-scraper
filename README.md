# 曲库刮削

[English](README.en.md)

曲库刮削从 MusicBrainz 识别已入库的本地录音，将有把握的元数据写入原生标签，并按所选预设整理文件。文件的媒体流、编码、扩展名和歌曲 ID 保持原样，歌单成员和播放历史继续关联同一首歌。

## 安装

1. 使用包含曲库刮削 Bridge 的 Songloft 后端。插件打开时检查宿主接口，具备所需接口的 `dev` 构建也可使用。
2. 从 [GitHub Releases](https://github.com/songloft-org/songloft-plugin-music-scraper/releases) 下载 `music-scraper.jsplugin.zip`。在 Songloft 打开「设置 → JS 插件」，上传并启用。
3. 从插件入口打开「曲库刮削」。支持原生插件的 Lynx 客户端会加载原生界面。使用 WebView 的客户端会加载同一界面的 Web 回退。Web 回退需要能提供 Lynx Web 运行时的后端部署。
4. 如需 AcoustID，在插件首页点击「设置 AcoustID」，填写应用 key 后保存。保存空值可清除配置。首次打开时，插件会显示配置状态及 Chromaprint 可用性。插件可复用已保存的指纹，文字识别不依赖 key。使用已启用的歌词和封面提供者补齐缺失内容。[AcoustID 应用 key](https://acoustid.org/webservice)

有可用指纹和 key 时，插件向 AcoustID 发送音频指纹及完整时长。文字匹配向 MusicBrainz 发送曲目信息。向提供者发送的参数沿用宿主接口。

## 使用

1. 勾选已入库的目录。目录包含子目录，同时勾选父子目录时只处理一次，以父目录为整理根。
2. 选择目录结构和文件名。默认保持原目录并使用 `歌手-歌名`，多歌手使用 `歌手1&歌手2-歌名`。也可平铺到所选目录，或在所选目录下按第一位歌手和可靠的专辑分目录。专辑无法确认时，该曲保留原目录。
3. 检查「开始刮削」旁的曲目数和路径示例。示例使用曲库现有标签，实际目标取决于匹配结果。
4. 开始刮削。高把握结果自动写入。有疑问的版本进入「待确认」。打开结果可查看完整路径、歌手、专辑、版本和时长。只有点选对应候选的「写入此版本」才会写入该首歌。

刷新可接回正在运行的任务。插件重载或宿主重启后，仍可查看最近一次任务保存的结果。重载时仍在运行的任务会标记为已中断。开始新任务会替换上次结果。取消时会保留已写入的曲目。路径冲突、CUE 或其他共享音频、源文件变更及无法安全写入的格式会逐首显示。整理后的文件会继续使用旁挂歌词，原旁挂文件会保留以免影响共享它的其他录音。插件会保留后端记录的手动字段以及现有嵌入歌词和封面。

## 本地开发

使用 Node.js 22.14+ 和 pnpm 9.15.0，在本目录运行以下命令。

```sh
pnpm install --frozen-lockfile
npm run dev
```

更新源码后重新运行 `pnpm install --frozen-lockfile` 同步依赖。如果开发构建提示无法解析 `opencc-js/t2cn`，先停止监听，安装依赖后重新运行 `npm run dev`。

开发命令默认连接 `http://localhost:58091`。通过 `npm run dev -- --host http://localhost:58191` 可指定其他实例。首次登录后，工具链会构建、上传并启用插件，之后监听后端和 Lynx 前端源码的改动，重新构建并上传。开发登录配置保存在本地 `.songloft-dev.json`。

插件的 QuickJS 后端负责匹配、繁简转换、整理预设和任务状态。宿主 Bridge 提供曲库查询、按曲目补算指纹、歌词与封面提供者查询，以及带源文件检查的标签写入和移动。AcoustID 设置和任务结果保存在插件的宿主存储中。

## 从源码构建

使用 Node.js 22.14+ 和 pnpm 9.15.0，在本目录运行以下命令。打包产物在 `dist/music-scraper.jsplugin.zip`。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm validate
```

`main` 上的代码推送会在 GitHub Actions 构建并校验 Linux 上打包的 QuickJS 字节码、Lynx 原生界面及 Web 回退，可从工作流下载 ZIP。需正式发布时，在 **Package Plugin** 工作流中选择 `main` 并勾选 `publish`。发布采用上海时区的 `年.月.日.序号`，并将来源提交、下载地址和校验值写入发布清单。
