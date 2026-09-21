# 自行部署（腾讯云 SCF + COS + 飞书）

GitHub 或本地 Git 只保存源代码。运行环境必须由你自己创建，并且应长期有效：不要用临时隧道、会过期的预览域名，或依赖某台电脑一直开机。云资源和模型 API 按实际用量计费，本文不承诺免费。

当前打包脚本是 Windows PowerShell。在 Windows 上 `npm ci` 后使用：

```powershell
npm run check
npm test
npm run package:scf:cos
```

会生成 `scf-ingress.zip`（接收函数）和 `scf-processor.zip`（处理函数）。入口均为 `index.main_handler`。再次打包会因压缩时间戳变化而产生不同哈希，部署前应记录实际上传文件的 SHA-256。

Linux/macOS 不能直接运行该打包脚本；不要把当前脚本说成跨平台发布器。

## 你需要准备的资源

- 腾讯云账号，SCF 与 COS 建议同一地域（文档示例使用广州 `ap-guangzhou`）
- 私有读写 COS 存储桶，**不要**开公有读
- 两个 SCF 函数（Node.js 18.15）：
  - 接收函数：128 MB、约 15 秒、开启公网、函数 URL 供飞书回调
  - 处理函数：256 MB、**至少 180 秒**、开启公网、不需要函数 URL
- 飞书企业自建应用，事件订阅指向接收函数 URL
- 文字模型 API（OpenAI 兼容即可）
- 可选：视觉理解与生图 API

函数应使用 SCF 运行角色访问 COS，不必把长期腾讯云 SecretId/SecretKey 写进函数代码。

## 建议的 COS 前缀

空前缀实例（兼容旧路径）：

- `inbox/` 飞书事件
- `processed/` 去重
- `errors/` 诊断
- `state/` 世界与角色状态
- `locks/` 短锁
- `packs/` 角色包版本对象

若使用示例角色，准备命令会给出带 `storage_prefix` 的路径，例如 `instances/your-owner-id/harbor-fox/inbox/`。接收函数、处理函数和 COS Put 触发器必须使用同一前缀。存储前缀只隔离路径，不代替访问控制。

## 接收函数环境变量

把 `examples/scf.env.example` 中接收函数一段复制到控制台，并换成你的值：

```text
COS_BUCKET=your-private-bucket
COS_REGION=ap-guangzhou
FEISHU_VERIFICATION_TOKEN=your-feishu-verification-token
```

若实例带前缀，还需让接收函数写入 `storage_prefix/inbox/`。当前实现通过处理函数侧的实例绑定与触发器前缀对齐；不要只改其中一个。

## 处理函数环境变量

最少需要：

```text
COS_BUCKET=your-private-bucket
COS_REGION=ap-guangzhou
FEISHU_APP_ID=your-feishu-app-id
FEISHU_APP_SECRET=your-feishu-app-secret
FEISHU_VERIFICATION_TOKEN=your-feishu-verification-token
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.example.com
AI_MODEL=your-text-model
AI_API_KEY=your-text-api-key
BOT_TIMEZONE=Asia/Tokyo
IMAGE_MODE=disabled
VISION_MODE=disabled
```

完整占位列表见 `examples/scf.env.example`。示例角色的时区是 `Asia/Tokyo`；宿主环境变量仍可覆盖包内时区。

绑定示例包：

```powershell
node scripts/character-pack.mjs prepare examples/harbor-fox.json examples/instance.example.json activation-plan.json
```

将生成文件中的 `LIFE_ENGINE_PACK_KEY`、`LIFE_ENGINE_PACK_SHA256`、`LIFE_ENGINE_CONFIG_JSON` 写入处理函数。先上传并核对 `packs/<id>/<version>.json`，再切换绑定。不要用不同字节覆盖同一版本键。

## COS 触发器与心跳

处理函数增加 COS 触发器：

- 事件：`cos:ObjectCreated:Put`
- 前缀：该实例的 `inbox/`（空前缀则为 `inbox/`）
- 后缀：`.json`

必须限制前缀，避免写入 `state/` 时再次触发自己。

再增加 30 分钟定时触发器，只负责检查是否到期，不表示每 30 分钟都会活动或发消息。安静时段、每日活动次数和主动联系次数由角色包与环境变量决定。

## 照片模式

`examples/harbor-fox.json` 的 `assets` 为空。此时应保持 `IMAGE_MODE=disabled`，系统按文字生活运行，不会去找任何图库。

若要拍照：

1. 准备你拥有再分发或生成授权的参考图
2. 把文件放在本地资源目录，路径与清单中的 `key` 一致
3. 清单必须包含 SHA-256 与 MIME
4. `prepare` 时传入资源目录；缺失或摘要不符会失败
5. 再把 `IMAGE_MODE` 设为 `hybrid` 或 `api`，并配置生图/视觉变量

启用了角色包之后，参考图以来源清单为准。空清单不会继承其他角色的旧图库。

## 发布与回滚

1. 记录当前线上版本、更新时间和代码哈希，作为回滚点。
2. 上传新 ZIP，入口保持 `index.main_handler`，发布新版本；不要删除上一版本。
3. 只读核验触发器、健康记录和一条自然心跳，不要用付费测试消息代替。
4. 回退设定：恢复原来的包键、SHA-256 和宿主配置。这不会删除运行经历。
5. 回退代码：切回发布前保存的函数版本。

## 不要做的事

- 不要把本机密钥文件提交进 Git
- 不要把私有图片或生产 `state/` 导出进仓库
- 不要把存储前缀宣传成租户安全边界
- 不要把自动测试通过说成真实聊天或生图已经验收
