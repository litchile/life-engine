# 角色世界包

角色包是版本化的 JSON 设定：人设、世界、视觉规则、初始实体和可选参考图清单。运行存档是经历。更新包不得重置存档。

## 内置默认示例

引擎自带一个**默认示例角色**（`scf-runtime/packs/` 下的默认包）。它只是让引擎在未绑定任何包时也能启动的占位演示。正式部署应显式提供你自己的角色包，而不是依赖内置示例。

## 示例角色包

`examples/harbor-fox.json` 是一个可直接替换的示例：

- 角色：阿岚，赤狐
- 世界：潮声港
- 住所：旧灯塔客房
- 关系：空
- 参考图：`assets: []`

它是纯虚构演示，可整包替换成你自己的角色。本地测试用同一份结构验证：不同角色的聊天、心跳和照片计划相互隔离，不会串身份，也不会写入彼此的存储前缀。

校验与准备：

```powershell
node scripts/character-pack.mjs validate examples/harbor-fox.json
node scripts/character-pack.mjs export examples/harbor-fox.json harbor-fox-export.json
node scripts/character-pack.mjs prepare examples/harbor-fox.json examples/instance.example.json activation-plan.json
```

所有输出都写新文件，拒绝覆盖。`prepare` 不上传、不改云端权限、不调用模型。

实例绑定只允许：

```json
{
  "user_id": "your-owner-id",
  "character_id": "harbor-fox",
  "storage_prefix": "instances/your-owner-id/harbor-fox"
}
```

`character_id` 必须等于包 `id`。不要给不同角色复用同一个 `storage_prefix`。适配器只做路径拼接，宿主仍要自己管桶权限和前缀分配。

## 文字模式与照片资源

| 情况 | 行为 |
|---|---|
| `assets` 为空，且 `IMAGE_MODE=disabled` | 文字生活与聊天可运行，不尝试生图 |
| `assets` 为空，但开启生图 | 包清单仍是权威来源，得到空图库；不会去读其它角色的图库 |
| 清单声明了参考图，但对象不存在或 SHA-256/MIME 不符 | 读取时失败，不静默换成另一张身份图 |
| 未设置 `LIFE_ENGINE_PACK_KEY` | 使用内置默认示例设定；正式部署不建议依赖它 |

参考图必须位于 `media/packs/<包ID>/<版本>/`，单文件不超过 20 MiB。包文件本身不超过 512 KiB，不能含可执行字段、凭据或 `instance`。

## 回退

回退设定：恢复原来的包键、摘要和宿主配置。经历仍留在存档里。回退代码使用发布前的 SCF 版本包。
