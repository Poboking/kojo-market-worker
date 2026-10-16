import type { RejectCode } from './schema';

/**
 * 拒绝话术：作者只看 message（说人话：哪里出了问题、包没发出去），code 只进日志。
 * 口径照编辑器 ui-market 的 PLATFORM_FAIL_TEXT/REJECT_TEXT 风格：一句主话 + 一个动作建议。
 */
export const REJECT_TEXT: Readonly<Record<RejectCode, string>> = {
  /* ---- 清单类 ---- */
  'manifest-missing': 'zip 根部没有 pack.json——包结构不对，请在编辑器里重新导出',
  'manifest-json': 'pack.json 不是合法 JSON——文件可能在导出时被截断，请重新导出',
  'manifest-shape': 'pack.json 的字段不符合市场契约，请对照编辑器导出的原始清单',
  'schema-version': '包的 schema 版本不被市场支持——请把编辑器升级到最新版再导出',
  'kind-unknown': '包类型（kind）不被市场支持，请重新导出',
  'id-invalid': '包 id 形态不合格（需小写字母/数字开头，可含 . _ -，≤64 字符）',
  'version-invalid': '包版本必须是 x.y.z 三段数字，请修改后重新导出',
  'min-app-version-invalid': 'minAppVersion 必须是 x.y.z 三段数字',
  'redistribute-denied': '这个包的作者没有许可代理分发（redistribute=false），市场不能收录它',
  /* ---- 路径类（防穿越零容忍） ---- */
  'path-prefix': '包内容文件必须放在 files/ 目录下',
  'path-absolute': '包里混入了绝对路径的文件，请重新导出',
  'path-drive': '包里混入了带盘符的路径（Windows 盘符不许出现在包里）',
  'path-backslash': '包里的路径含反斜杠——路径必须是 posix 相对路径，请重新导出',
  'path-dotdot': '包里混入了 .. 上跳路径（路径穿越），已拒绝',
  'path-empty-segment': '包里的路径含空段或 . 段，请重新导出',
  'path-depth': '目录嵌套太深（超过 12 层），请压平目录结构',
  'path-too-long': '某个文件的路径太长（超过 512 字节），请缩短文件名或目录名',
  /* ---- 内容对账类 ---- */
  'entry-duplicate': '清单里有重复的文件路径，请重新导出',
  'entries-limit': '包内容文件数超过上限（5000 个），请拆包',
  'bytes-limit': '包解压后总大小超过上限（128 MiB），请拆包',
  'entry-bytes': '某个文件的字节数与清单声明不符，请重新导出',
  'entry-sha256': '清单里的 sha256 摘要形态不对（应为 64 位小写 hex），请重新导出',
  'entry-missing': '清单声明了文件、但 zip 里没有——请重新导出',
  'entry-extra': 'zip 里有清单没声明的文件（多出来的内容不收）——请重新导出',
  /* ---- 容器类 ---- */
  'zip-unreadable': 'zip 解析失败——文件可能损坏或不是标准 zip，请重新导出',
  'zip-too-large': 'zip 本体超过 64 MiB 上限，请压缩内容或拆包',
  'payload-too-large': '上传体积超过上限（99 MB），请拆包后再传',
  'length-required': '上传必须声明 Content-Length（不支持分块传输）——请更新编辑器后重试',
  'container-digest': '包体 sha256 校验值缺失、形态不对或与实际内容不符——请更新编辑器后重新导出上传',
  /* ---- 发布链路 ---- */
  'token-invalid': '设备凭证无效——请在编辑器里重新获取发布凭证',
  'token-expired': '设备凭证已过期——请在编辑器里重新获取发布凭证',
  'version-published': '这个 id + 版本已经在注册表上了——修改内容请 bump version 后重新发布',
  'id-kind-conflict': '这个包 id 已经以另一种包类型收录，一个 id 只能属于一种类型',
  'r2-failed': '存储服务暂时不可用（包没有进入待审区），请稍后再试',
  'github-failed': '向注册表仓开 PR 失败——包已在待审区，维护者可手工处理，请稍后再试或联系维护者',
  'not-found': '接口不存在',
  'method-not-allowed': '请求方法不对',
  'internal': '服务内部错误，请稍后再试',
};
