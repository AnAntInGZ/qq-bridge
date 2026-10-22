# 安卓节点与手机活动

本批把固定安卓设备接入角色活动，提供 2048 和 B 站 App 的受限执行链路。默认关闭，已做离线像素/规则/ADB/真实 bridge VM 验证；尚未启动真实 Android 或验收某个 B 站版本。开发记录见 [实施计划](../plans/2026-10-21-android-activities.md)。

## 部署结构与选型

当前部署方向是 Windows 本机模拟器，由原服务器远程控制；独立 Linux Redroid 和云手机保留为可选方案。原服务器保留 QQ、DSH、SQLite、活动调度和 ADB 客户端。操作层统一是截图/UI 观察、受限动作和结果核对，厂家 API 不进入模型工具面。

自建基准为 Redroid Android 13、720×1280、软件渲染、memfd。选型依据是 [Redroid 官方文档](https://github.com/remote-android/redroid-doc) 和 [Android 官方 ADB 文档](https://developer.android.com/tools/adb)。Redroid 的特权容器能接触宿主内核，应放独立节点；不挂载 QQ/DSH 凭据或 Docker socket，不把运行容器权限交给模型。

Debian 12 可以作为节点系统，12.10 镜像安装后应更新安全补丁。[Redroid 的 Debian 12 部署说明](https://github.com/remote-android/redroid-doc/blob/master/deploy/debian.md) 要求核对 Binder；还需核对官方列出的 memfd、IPv6、DMA-BUF 和 4KiB 页等内核条件。不能只凭发行版名称保证运行。深圳机房可以，节点地域不影响接口；实际网络延迟、截图传输、B 站可访问性和 App 兼容性仍要实测。

本项目建议 2 核 4GB 作为最低试运行配置，4 核 8GB 更稳妥；这是工程建议，尚无真实 App 性能基准。2 核 2GB 可能启动精简安卓，但不作为稳定 B 站视频节点的验收规格。启动检查要求至少 3GiB 当前可用内存、10GiB 部署目录可用空间。主服务器不需要升级到安卓节点的规格，但也须保留图片缓冲和 ADB 的资源余量。

云手机同样可以分离部署：

- [阿里云云手机 ADB](https://www.alibabacloud.com/help/en/ecp/how-to-connect-cloud-phone-via-adb)：有密钥与网络配置要求，支持的连接方式取决于实例网络类型。
- [腾讯云手机接入](https://cloud.tencent.com.cn/document/product/1801/122845)、[创建 ADB 连接](https://cloud.tencent.com/document/api/1162/118978)：通过后台接口取得连接资料，凭据由管理员管理。
- 已实现的是标准 ADB 操作层。两家云手机的开通、临时连接/密钥更新、规格费用及该账号能否购买尚未验证；没有自动创建收费资源或保存厂家凭据。


## Windows 本地模拟器（当前部署方向）

用户已改为在 Windows 启动模拟器，Linux 安卓节点停止推进。结构为：

    原服务器：QQ / DSH / SQLite / 调度 / ADB 客户端
        -> 127.0.0.1:15555
        -> Windows 主动建立的 SSH 反向隧道
        -> Windows 127.0.0.1:实例端口
        -> 指定安卓模拟器

Windows 无需家庭公网 IP 或入站端口映射，只要能主动连接服务器 SSH。建议独立 MuMu 实例，先分配 4 核、4GB、720×1280 竖屏；本机核查为 6 核 12 线程、32GB 内存、VT 已开启，资源足以试运行，但实际图形兼容性仍待验证。也可使用官方 Android Emulator 或其他提供标准 ADB 的模拟器。[MuMu 官方说明](https://www.mumuplayer.com/help/win/fix-network-error.html) 指出实例端口应从多开器的 ADB 信息或问题诊断读取，不猜测固定端口；[官方 Android Emulator](https://developer.android.com/studio/run/emulator-acceleration) 在 Windows 优先使用 WHPX。

1. 从模拟器官网下载并启动独立实例；不要复用私人日常手机实例。保持实例运行，确认 ADB 调试开启、竖屏和固定分辨率。手工打开到游戏正常棋盘，处理首次提示。
2. 使用实例自带或官方 platform-tools 的 adb.exe。确认端口仅供本机访问；不启用网络桥接或为 ADB 添加公网入站规则。以下 PORT 替换为实际设备端口，绝不是 ADB 服务端口 5037：

       & "C:/实际目录/adb.exe" connect 127.0.0.1:PORT
       & "C:/实际目录/adb.exe" -s 127.0.0.1:PORT shell settings get secure android_id

3. 在 SSH 配置中准备指向原服务器的别名 qq-bridge，提前核对主机指纹和公钥登录。服务器安装 ADB 客户端、保留 ss 命令；不需要安装模拟器。不要为转发开启服务器 GatewayPorts 公网监听。
4. 在仓库目录先预览命令，再显式建立连接。例子中的路径、端口和 DEVICE_ID 均需替换：

       npm run android:tunnel -- --server qq-bridge --local-port PORT --ssh "C:/Program Files/Git/usr/bin/ssh.exe"
       npm run android:tunnel -- --server qq-bridge --local-port PORT --ssh "C:/Program Files/Git/usr/bin/ssh.exe" --adb "C:/实际目录/adb.exe" --device-id DEVICE_ID --apply

   可用 --identity 指定已有密钥文件，不复制密钥内容。脚本默认只预览；apply 后先核对本机实例身份、拒绝占用的服务器端口，再创建反向转发并检查实际监听地址。若 sshd 把监听扩大为公网或启动失败，关闭此次隧道。不安装软件、不登录 App、不修改真实桥接配置、不创建自启任务、不自动重连。
5. 保持该终端运行。桥接配置 serial 设为 127.0.0.1:15555，deviceId 填实际 android_id，后续按下文校准版本和棋盘。服务器连接第一次可能需要在模拟器中确认该服务器的 ADB 公钥。
6. 关闭电脑、休眠、断网或 Ctrl+C 会中断连接。恢复后未知活动需要管理员 reconcile，不重放动作。人工使用实例前先停止活动并确认应用已退出。

新增脚本见 [反向隧道](../../scripts/android-reverse-tunnel.mjs)。已用临时 TCP 回显端点实测 Windows 到原服务器的反向 SSH 往返，并确认结束后服务器端口清空；该结果只证明网络通路，不代表真实 ADB、2048 或 B 站已经联调。

## 自建 Redroid

文件为 [Compose](../../deploy/android/compose.yml)、[SSH 隧道服务示例](../../deploy/android/qq-android-tunnel.service.example)、[只读前置检查](../../scripts/check-android-host.mjs) 和 [显式启动脚本](../../scripts/start-android.mjs)。

以下均属于管理员在选定安卓节点上的部署步骤，不在 npm run check 中运行：

1. 安装 Docker/Compose 和 Android platform-tools；按内核实际支持加载 Binder，提供 /dev/binder、/dev/hwbinder、/dev/vndbinder。不要自动替换云机内核或重启现有业务。
2. 手工取得官方 redroid/redroid:13.0.0-latest 镜像并核对摘要，把 REDROID_IMAGE 设为 tag@sha256:摘要。只接受固定摘要，启动脚本不拉取镜像。
3. 在节点运行 npm run android:check。检查不加载模块、不启动容器。未通过时处理具体前置条件。
4. 读完 Compose 后，运行 npm run android:start -- --apply。它拒绝覆盖同名容器，数据目录限制为 deploy/android/data，权限为 0700，已从 Git 忽略。只返回“容器启动请求已完成”，不等于 Android 或 App 已可用。
5. 核对 Android 启动、ADB 鉴权、系统版本、渲染、720×1280 竖屏和实际截图；完成下面的 App 校准后再开启桥接活动。

Compose 显式绑定三个 Binder 设备，使用 memfd，ADB 仅绑定节点 127.0.0.1:5555；容器内存上限 2GB、CPU 上限 2 核。内核、镜像或权限不满足时应停止核对，不通过放开公网 ADB 来排障。

## 主服务器连接独立节点

在主服务器的桥接运行用户下配置 SSH 别名 qq-android-node，指向独立节点的专用 SSH 用户并核对主机指纹。用 SSH 公钥和受限转发权限，仅允许转发安卓节点的 127.0.0.1:5555。服务示例可复制后改为实际服务用户，不含服务器地址或密钥。

手工验证隧道命令：

    ssh -NT -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes -L 127.0.0.1:5555:127.0.0.1:5555 qq-android-node

桥接配置的 serial 保持 127.0.0.1:5555。执行器在活动开始时连接该固定回环端点，并要求 get-state=device；未鉴权、离线或连接错误均拒绝。不会自动添加 SSH 主机信任、读取云厂商密钥或连接任意公网 ADB 地址。云手机按厂家文档先建立受保护连接，再映射到这个回环端点。

隧道断开或临时连接过期会终止活动并保留待核对状态。恢复隧道不能恢复旧点击；管理员需重新核对后发起新活动。一个安卓节点只交给一个桥接实例控制，人工使用 scrcpy 前先执行停止并等待确认。

## App 安装与校准

安装 APK、登录、处理权限、验证码及首次说明由管理员完成；本程序不下载或安装 App。版本变化后必须重新校准。

2048 固定为 [uberspot/2048-android](https://github.com/uberspot/2048-android) 的 com.uberspot.a2048，开源离线 WebView 游戏。使用默认浅色主题、标准 4×4 棋盘；首次教程与新游戏界面应人工处理。不要把同名商业 2048 当作已支持版本。

先取得该设备的 PNG 截图和 dumpsys package 输出，记录实际 versionName。可离线运行：

    node scripts/calibrate-android-2048.mjs screenshot.png 720 1280

工具只读取指定 PNG，返回棋盘 left、top、size、gap、识别格子及 reviewRequired=true。核对棋盘位置与格子后填写配置；它不写真实配置、不触控设备。无法唯一识别时停止，不能把未知颜色补成空格。PNG 和 UI 样本不要放进仓库。

B 站固定包名 tv.danmaku.bili，必须以实际版本校准四个资源编号：

| 字段 | 必须表示 |
| --- | --- |
| feedReady | 推荐列表的明确标记 |
| feedTitle | 卡片中可见视频标题 |
| feedCard | 卡片容器的资源编号；**允许留空**，表示按"标题的最近可点击祖先"定位 |
| playerReady | 视频播放器的明确标记 |

资源编号必须属于 tv.danmaku.bili:id/...，不能提供任意选择器、脚本或坐标。标题必须通过真实父子树绑定到卡片，卡片区域不得覆盖画布 30% 以上且范围内只能有一个已校准标题。只选 content-desc 首段为"视频"的普通横版卡片；竖版视频（StoryVideoActivity）、直播、会员购、广告与付费内容都不进候选。

为什么不校准播放器标题和进度：实测 9.16.1 的详情页里 `resource-id=title` 是合集名、UP 主名和推荐位标题，真正的视频标题只在媒体会话里；播放器是自绘 SurfaceView，UI 树没有时间文本，`dumpsys media_session` 的 position 也恒为 0/200 不随播放增长。因此播放证据改为三者互证：

1. `dumpsys media_session` 的 `state=PLAYING`，且 metadata 标题与点开的候选一致（允许媒体会话截断，见 `sameTitle`）；
2. 两次截图的像素变化率超过 0.2%（实测播放约 18%～31%，暂停为 0）；
3. 墙钟时长达到本条的计划停留时长，且期间标题不变、仍在播放态。

控制条不可观察、标题不一致、媒体会话未在播放或画面无变化都会停止，不能降级盲点。

已知平台约束（Android 15 / MuMu）：`dumpsys window windows` 不再输出 mCurrentFocus，焦点校验统一用全量 `dumpsys window`；`uiautomator dump` 写完后会以 139（段错误）退出，产物已落盘，因此先删旧文件、容忍该退出码，再以 XML 完整性校验作为唯一判据。

跨公网隧道时截图必须走文件：同样一张 1080p 画面，`exec-out screencap` 实测 29 秒，写成设备临时文件再 `adb pull` 只要 3.6 秒——瓶颈是流式回传的小包往返，不是设备编码。因此观察改为先落盘再拉取，并且只在判断"画面有没有推进"时截图，其余观察只读 UI 树和媒体会话。`adb shell` 还会偶发以 135（SIGBUS）退出，只读命令和滚动通过 `retryExit` 重试一次，点击和返回不重试，避免重放有副作用的动作。UI 文本里的坏码点（控制字符、截断的代理对）替换为占位符而不是让整次观察失败。

## 配置与运行

字段位于 character.android，[配置模板](../../config.example.json) 默认全关：

| 字段 | 说明 |
| --- | --- |
| enabled | 安卓执行总开关，依赖 character.enabled |
| adbPath / serial | ADB 可执行文件与固定本机设备；支持回环端口或 emulator 编号 |
| deviceId | 实际 settings get secure android_id 的 16 位小写十六进制值；启用必填，防止隧道指向其他实例 |
| scope | 明确的 public、private:编号 或 group:编号；默认 internal 禁止启用。建议独立设备先绑定 owner 私聊 |
| width / height | 固定截图尺寸 |
| dailySeconds / dailyActions | 每日设备时长/动作预留额度，默认 0 |
| activitySeconds / maxActions | 每次活动预留量及上限；活动 10～600 秒，动作 1～200 次 |
| game.enabled / version / board | 2048 开关、实际版本与校准棋盘 |
| bilibili.enabled / version / selectors | B 站开关、实际版本及完整资源编号 |
| bilibili.watchSeconds / deepWatchSeconds / maxVideos / scrolls | 最短停留 2～120 秒；命中兴趣时的停留为 watchSeconds～300 秒（0 表示跟随 watchSeconds）；单次最多连续 1～8 条视频；最多 0～6 次列表滚动 |
| bilibili.analyze / clipSeconds | 是否录一段现场画面交给 Seed 判断内容（默认关）；录制 4～15 秒且不得超过 watchSeconds。仅当 videoAnalysis.enabled 同时为真才会装配，否则整条链路不产生方舟请求 |

一次活动是连续浏览而不是单条打卡：每条按标题命中 interests 的词数决定停留——两个词都命中看满 deepWatchSeconds，命中一个看两者中间值，完全没命中只看 watchSeconds 就划走。剩余预算不够一条完整观察时主动收尾，已确认的观看仍然成立并按完成记录：预算耗尽属于"待够了离开"，不是故障。只有观察失败、标题不一致、播放中断或画面无变化才判失败。

点开之后发现不是列表里的那一条（广告跳转、直播、推荐漂移）时按"开错门"处理：先结清这一步动作，再退回推荐列表换一条继续，叙述里如实写"另有 N 条点开后不是列表里的那一条"，不把这条算进观看条数。真人也是退出来换一个，不会因此今天就不刷了。连续 3 条都错才收尾——那时多半是页面结构变了，再点只是白花动作额度。预算到点、准入失效、动作额度用完属于整场结束，不走跳过。

开启 `bilibili.analyze` 后，确认播放的当下会录一段（`clipSeconds`）现场画面，交给 [Seed 视频分析](VIDEO_ANALYSIS.md) 判断内容品类与主题，结果写进这条经历并计入证据。录制时长算进这次停留，不会额外拉长"看了多久"。分析失败只降级为纯播放证据，并在证据里留下 `android-clip-error`，不影响这次观看成立；超时 45 秒封顶，不能拖穿活动预算。片段只存在于 `state/activity-clips/` 的分析期间，读完即删。

时长与动作按同一预算时区持久预留；失败、取消及未知操作均不退还预留，清理耗时超过预留时提高占用。重启和回拨不重发，换时区拒绝新活动。作息启用时同样约束设备操作。上限是宿主停止发出动作和请求应用退出的控制，不能保证网络断开时远端 App 立即退出；未确认停止将一直阻断新活动。

管理员接口沿用控制台令牌、Host、Origin 和正文限制，普通 QQ agent 一律拒绝：

| 请求 | 正文与效果 |
| --- | --- |
| GET /api/character/android/status | 设备活动、故障、预算、待核对任务及最后确认的数值进度 |
| POST /api/character/android/start | {"kind":"game"} 或 {"kind":"bilibili"}，发起一次明确活动，不调用生活模型 |
| POST /api/character/android/stop | {}，暂停生活调度、撤销未开始意图，等待当前命令与应用退出 |
| POST /api/character/android/reconcile | {}，保持暂停，核对停止并取消未知任务；不会重放动作 |

先完成校准并开启 character.enabled/android.enabled，管理员解除暂停，再用单次接口验证设备。若开启 character.autonomy.enabled 并配置作息和模型额度，生活决策会得到已授权范围内的安卓候选；成功提交后主协调器才领取执行。关闭自主模型时仍可管理员单次验证。管理界面暂为 API，没有图形按钮。

## 事实、停止与恢复

2048 使用确定性规则和启发式求解，每次只滑一个方向，随后要求棋盘恰好符合合并规则并新增一个 2 或 4。命令受理不计为有效移动；棋盘不变、动画未稳定、未知颜色或弹窗均停止，不自动重试点击。最大方块、无合法移动等以实际棋盘核对，不承诺必胜。

B 站只浏览已校准推荐列表和视频播放器，可按已有兴趣主题匹配标题。选择、观察覆盖与停止结果形成经历：没开录屏分析时明确写“未分析画面或音轨，不代表完整看完”，开启后逐条注明画面内容，并如实区分“看过画面”的条数与只有播放态证据的条数，两者都不代表完整看完。仍不投币、评论、收藏、关注或支付。

SQLite 从 v3 升级到 v4 前先快照，再事务迁移，v1/v2 沿用原升级链。活动领取和预算预留同事务；触控前持久登记动作，核对后再确认。截图先写入设备固定临时文件再 pull 到宿主临时目录，读入内存后立即删除两侧副本；UI 树同样在设备 /data/local/tmp 的固定临时文件中生成，读取后删除，停止/恢复时再次清理。宿主不持久保存原始截图/UI，持久动作日志只含类型、范围、哈希与状态。设备断连时临时文件可能残留，需恢复连接后核对清理。

每次准备和观察核对 android_id，启动通过唯一 launcher 组件，不注入随机事件。任务同时绑定设备、版本和记忆版本；更换实例不能解除旧实例的未知占用。暂停、权限撤销、作息到点或删除记忆后不再发新动作。已登记但未执行的旧记忆版本计划也作废。停止使用固定包名 force-stop，并核对主进程和同包子进程；没有退出与清理证据时维持未知占用。重启先暂停，未知任务通过 reconcile 明确取消，不沿旧坐标接续。删除更正沿用已有上下文失效流程；原有 QQ 聊天权限继续独立管理。

## 验证与未覆盖

npm run test:character 包含真实 PNG、棋盘规则、假 ADB、预算/迁移、B 站连续浏览、开错门跳过与连续开错的收尾、录屏分析的降级路径和实际桥接 VM/HTTP 测试，不接触真实设备或账号。Windows 上跑 `scripts/test-video-analysis.mjs` 会有一条符号链接用例失败：沙箱里 `fs.symlinkSync` 不报错但链接并未真正创建，HEAD 基线同样如此，Linux 上通过，属于平台差异而不是回归。

已在 MuMu（Android 15、B 站 9.16.1，服务器经 SSH 反向隧道接入本机 7555）上实测：一次 600 秒活动连续看完 6 条、共 173 秒，无故障；开启录屏分析后，经历里逐条带上画面内容（实测识别出 UP 主、标题和点赞数），Seed 单次分析约 22 秒。1440×2560 下逐次观察约 6.3 秒（不截图）或 13.4 秒（截图）。真机上"点开却不是那一条"出现得并不罕见：修好跳过之前，一次 4 条、共 120 秒的活动就是以一次标题不匹配提前收尾的。

尚未覆盖：云手机厂商的连接方式、连续多日的长时稳定性、断网重连后的自动恢复。离线夹具通过不代表这些环节通过。最终检查记录见 [实施计划](../plans/2026-10-21-android-activities.md)。
