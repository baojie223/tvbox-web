# 放映室

在 Windows 上用浏览器打开 TVBox 订阅，按频道或分类浏览，搜索名称，选择播放线路和剧集。

## 启动

本机安装 Node.js 22 或更新版本后，双击 `启动放映室.cmd`。首次启动会安装依赖，随后用默认浏览器打开 `http://127.0.0.1:4380`。关闭启动窗口即可停止服务。

也可以在项目目录执行：

```powershell
npm ci
npm start
```

首次打开会自动加载王二小放牛娃。通过「订阅设置」可以更换地址，浏览器会记住最后一次成功加载的订阅。

## 片源支持

- **直播**支持订阅中的 HTTP(S) M3U 和 TVBox 文本频道清单。播放失败时可切换频道的其他线路或换一个清单。
- **点播**支持王二小放牛娃的 `csp_BiliGuard` 分类和公开 MP4、饭太硬的「兔小贝」，以及 TVBox `type: 0` XML、`type: 1` JSON 采集接口提供的媒体直链。哔哩哔哩线路在选择分集时获取播放地址，搜索按各线路的订阅设置开放。
- **播放**支持 HLS，以及浏览器支持的 MP4、WebM 等格式。播放器会识别没有文件后缀的 HLS。开始播放前遇到错误时，会尝试提供同一集的其他线路。Node 服务监听 `127.0.0.1`，负责读取订阅和转发播放请求。
- 「订阅设置」列出需要额外运行时的线路。Android 桥接版将王二小放牛娃和饭太硬的 Java、QuickJS 爬虫交给模拟器处理。

## Android 桥接版

通过「订阅设置」加载王二小放牛娃或饭太硬，在「点播」选择片源。线路能否播放取决于当时的上游响应、账号配置和浏览器支持的格式。可以用片源筛选框快速定位线路。

首次使用扫码登录时，在模拟器的 FongMi「设置 → 点播」保存王二小订阅 `http://new.xn--4kq62z5rby2qupq9ub.top/`。随后在放映室进入「点播 → 配置┃中心 → 网页版配置中心」，再点「打开配置页」。在新标签页选择服务并扫码，授权由模拟器里的爬虫保存。

在本机的 `TVBoxWeb` 模拟器中打开 FongMi 影视 5.8.7，并为脚本线路安装官方 QuickJS 模块。通过 ADB 将 Android 的 `9978` 端口转发到 Windows 的 `19978`，然后启动独立服务：

```powershell
$env:TVBOX_ANDROID_ADB = 'C:\Code\tools\tvbox-android\sdk\platform-tools\adb.exe'
$env:TVBOX_ANDROID_SERIAL = 'emulator-5560'
& $env:TVBOX_ANDROID_ADB -s $env:TVBOX_ANDROID_SERIAL forward tcp:19978 tcp:9978
$env:TVBOX_ANDROID_PORT = '19978'
$env:TVBOX_PORT = '4382'
npm start
```

打开 `http://127.0.0.1:4382`，进入「点播 → 独播┃秒播」可测试王二小的电影或电视剧。

逐条验证可在同一环境下另开终端运行 `node audit-sources.mjs <结果 JSON 路径>`。默认从 `4382` 读取两份订阅。用 `TVBOX_AUDIT_PORT` 指定服务端口，用 `TVBOX_AUDIT_FILTER` 按片源名称筛选。设置 `TVBOX_AUDIT_DEEP=1` 可增加片目、搜索和分集的样本数。取流通过表示至少有一个样本返回了媒体数据，网页实播另需检查画面和播放进度。

## 花卷 4K 的 Node 试验

在新的 PowerShell 中进入本项目目录，启动独立实例：

```powershell
$env:TVBOX_HUAJUAN_NODE = '1'
$env:TVBOX_PORT = '4384'
npm start
```

打开 `http://127.0.0.1:4384`，选择王二小订阅的「花卷┃4K」。Node 直接读取花卷的分类、搜索和详情，并使用夸克游客会话读取分享目录和取流。可用「搜此片源」搜索《饕餮嘟嘟驾到，太子爹爹转运啦》，验证夸克线路的第 49、50 集。

原画超过游客下载限制时，打开「夸克扫码登录」，使用手机夸克 App 扫码确认，再回播放器重试。账户会话通过 Windows 当前用户的 DPAPI 加密，保存在 `%LOCALAPPDATA%\TVBoxWeb\quark-session.dpapi`。服务重启时自动恢复，扫码页的「退出本机登录」会清除保存的会话。原画能否直接取流取决于夸克的文件和账号权限。

花卷 Matroska 原画使用 E-AC-3 等音轨时，播放器通过 FFmpeg 输出 AAC 立体声并直接复用视频码流。Windows x64 在 `npm ci` 时安装本地 FFmpeg，也可以通过 `TVBOX_FFMPEG` 指定可执行文件。HEVC 原画需要浏览器支持 HEVC 播放。

支持 SubRip、ASS 等内嵌文字字幕的 H.264 和 HEVC Matroska 原画会随播放加载字幕。可在播放器的字幕菜单中切换或关闭，有简体中文时默认显示简体中文。ASS 转为 WebVTT 后使用浏览器的字幕样式。
